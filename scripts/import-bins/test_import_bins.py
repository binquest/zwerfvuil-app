"""Tests for import_bins.py.

Run from the repo root: python -m unittest discover -s scripts/import-bins

The integration tests need the local Supabase database (npm run db:start) and
are skipped when it is not reachable. They run in a transaction that is always
rolled back, so existing data is left untouched.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import import_bins as ib  # noqa: E402

# Far above real OSM ids, so they never collide with imported data.
FAKE_ID = 900_000_000_000_000


def feature(osm_id, lon=3.716, lat=51.052, tags=None, osm_type="node"):
    return {
        "type": "Feature",
        "id": f"{osm_type}/{osm_id}",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"osm_type": osm_type, "osm_id": osm_id, "tags": tags or {"amenity": "waste_basket"}},
    }


def collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


class EligibilityTests(unittest.TestCase):
    def test_plain_and_trash_bins_are_eligible(self):
        self.assertTrue(ib.is_eligible({"amenity": "waste_basket"}))
        self.assertTrue(ib.is_eligible({"waste": "trash"}))
        self.assertTrue(ib.is_eligible({"waste": "trash;cigarettes"}))
        self.assertTrue(ib.is_eligible({"access": "yes"}))
        self.assertTrue(ib.is_eligible({"access": "customers"}))

    def test_special_purpose_waste_is_not_eligible(self):
        self.assertFalse(ib.is_eligible({"waste": "sharps"}))
        self.assertFalse(ib.is_eligible({"waste": "dog_excrement"}))
        self.assertFalse(ib.is_eligible({"waste": "sharps;dog_excrement"}))
        self.assertFalse(ib.is_eligible({"waste": " Dog_Excrement "}))

    def test_mixed_waste_with_trash_stays_eligible(self):
        self.assertTrue(ib.is_eligible({"waste": "trash;dog_excrement"}))

    def test_private_access_is_not_eligible(self):
        self.assertFalse(ib.is_eligible({"access": "private"}))
        self.assertFalse(ib.is_eligible({"access": "no"}))
        self.assertFalse(ib.is_eligible({"access": "private", "waste": "trash"}))


class ParseTests(unittest.TestCase):
    def test_parses_rows_with_eligibility(self):
        rows = ib.parse_features(collection(feature(1), feature(2, tags={"waste": "sharps"}, osm_type="way")))
        self.assertEqual([(r.osm_type, r.osm_id, r.eligible) for r in rows], [("node", 1, True), ("way", 2, False)])
        self.assertEqual((rows[0].lon, rows[0].lat), (3.716, 51.052))

    def test_rejects_invalid_input(self):
        bad = [
            {"type": "Feature"},
            collection(feature(1), feature(1)),
            collection(feature(1, osm_type="area")),
            collection(feature(0)),
            collection(feature(True)),
            collection(feature(1, lon=200)),
            collection({**feature(1), "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}}),
        ]
        for value in bad:
            with self.subTest(value=str(value)[:60]), self.assertRaises(ib.BinImportError):
                ib.parse_features(value)

    def test_same_id_with_different_type_is_allowed(self):
        rows = ib.parse_features(collection(feature(7), feature(7, osm_type="way")))
        self.assertEqual(len(rows), 2)


def connect_or_none():
    try:
        import psycopg

        return psycopg.connect(os.environ.get("DATABASE_URL", ib.DEFAULT_DATABASE_URL), connect_timeout=3)
    except Exception:
        return None


class DatabaseImportTests(unittest.TestCase):
    def setUp(self):
        self.conn = connect_or_none()
        if self.conn is None:
            self.skipTest("local Supabase database not reachable")
        ib.check_local(os.environ.get("DATABASE_URL", ib.DEFAULT_DATABASE_URL), allow_remote=False)

    def tearDown(self):
        if self.conn is not None:
            self.conn.rollback()
            self.conn.close()

    def run_import(self, *features, **kwargs):
        return ib.import_bins(self.conn, ib.parse_features(collection(*features)), **kwargs)

    def fetch(self, osm_id):
        with self.conn.cursor() as cur:
            cur.execute(
                """select status, eligible, tags, extensions.st_x(geom::extensions.geometry),
                          extensions.st_y(geom::extensions.geometry)
                   from public.bins where osm_type = 'node' and osm_id = %s""",
                (osm_id,),
            )
            return cur.fetchone()

    def active_osm_count(self):
        with self.conn.cursor() as cur:
            cur.execute("select count(*) from public.bins where source = 'osm' and status = 'active'")
            return cur.fetchone()[0]

    def test_full_lifecycle(self):
        a, b, c = FAKE_ID + 1, FAKE_ID + 2, FAKE_ID + 3
        already_active = self.active_osm_count()
        base = [feature(a), feature(b, lon=3.717), feature(c, tags={"waste": "sharps"})]

        first = self.run_import(*base, allow_mass_removal=True)
        self.assertEqual((first.inserted, first.updated, first.removed), (3, 0, already_active))
        self.assertEqual(self.fetch(c)[:2], ("active", False))

        again = self.run_import(*base)
        self.assertEqual((again.inserted, again.updated, again.unchanged, again.removed), (0, 0, 3, 0))

        changed = [feature(a, tags={"amenity": "waste_basket", "colour": "green"}), feature(b, lon=3.718), base[2]]
        result = self.run_import(*changed)
        self.assertEqual((result.inserted, result.updated, result.unchanged), (0, 2, 1))
        self.assertEqual(self.fetch(a)[2]["colour"], "green")
        self.assertAlmostEqual(self.fetch(b)[3], 3.718)

        without_c = self.run_import(*changed[:2])
        self.assertEqual((without_c.updated, without_c.unchanged, without_c.removed), (0, 2, 1))
        self.assertEqual(self.fetch(c)[0], "removed")

        back = self.run_import(*changed)
        self.assertEqual((back.inserted, back.updated, back.unchanged, back.removed), (0, 1, 2, 0))
        self.assertEqual(self.fetch(c)[0], "active")

    def test_eligibility_follows_tag_changes(self):
        a = FAKE_ID + 10
        self.run_import(feature(a), allow_mass_removal=True)
        self.assertTrue(self.fetch(a)[1])
        self.run_import(feature(a, tags={"access": "private"}))
        self.assertFalse(self.fetch(a)[1])

    def test_import_never_touches_eligible_override(self):
        a = FAKE_ID + 30
        self.run_import(feature(a), allow_mass_removal=True)
        with self.conn.cursor() as cur:
            cur.execute("update public.bins set eligible_override = true where osm_type = 'node' and osm_id = %s", (a,))
        result = self.run_import(feature(a, tags={"waste": "sharps"}))
        self.assertEqual(result.updated, 1)
        with self.conn.cursor() as cur:
            cur.execute("""select eligible, eligible_override, eligible_effective from public.bins
                           where osm_type = 'node' and osm_id = %s""", (a,))
            self.assertEqual(cur.fetchone(), (False, True, True))

    def test_user_bins_are_never_marked_removed(self):
        with self.conn.cursor() as cur:
            cur.execute("""insert into public.bins (geom, source) values
                           ('SRID=4326;POINT(3.716 51.052)'::extensions.geography, 'user') returning id""")
            user_bin = cur.fetchone()[0]
        self.run_import(feature(FAKE_ID + 20), allow_mass_removal=True)
        with self.conn.cursor() as cur:
            cur.execute("select status from public.bins where id = %s", (user_bin,))
            self.assertEqual(cur.fetchone()[0], "active")

    def test_refuses_empty_input_and_mass_removal(self):
        with self.assertRaises(ib.BinImportError):
            ib.import_bins(self.conn, [])
        many = [feature(FAKE_ID + 100 + i) for i in range(12)]
        self.run_import(*many, allow_mass_removal=True)
        with self.assertRaises(ib.BinImportError):
            self.run_import(*many[:5])
        self.conn.rollback()


class CheckLocalTests(unittest.TestCase):
    def test_refuses_remote_hosts(self):
        ib.check_local("postgresql://u:p@127.0.0.1:54322/postgres", allow_remote=False)
        ib.check_local("postgresql://u:p@db.example.com/postgres", allow_remote=True)
        with self.assertRaises(SystemExit):
            ib.check_local("postgresql://u:p@db.example.com/postgres", allow_remote=False)


if __name__ == "__main__":
    unittest.main()
