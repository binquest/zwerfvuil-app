#!/usr/bin/env python3
"""Import data/bins.geojson into public.bins.

In one transaction: upsert every feature on (osm_type, osm_id), reactivate
bins that reappear, and mark OSM bins that are no longer in the file as
'removed'. Unchanged rows are not touched, so updated_at stays meaningful.

Usage (from anywhere, paths are resolved from the repo root):
    python scripts/import-bins/import_bins.py
    python scripts/import-bins/import_bins.py --dry-run
    python scripts/import-bins/import_bins.py --file path/to/bins.geojson

The database URL comes from DATABASE_URL (shell or the repo-root .env) and
defaults to the local Supabase database. Non-local hosts are refused unless
--allow-remote is given.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import devenv  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FILE = ROOT / "data" / "bins.geojson"
DEFAULT_DATABASE_URL = devenv.DEFAULT_DATABASE_URL

OSM_TYPES = ("node", "way", "relation")
# Bins that must not earn points. A bin is only excluded when *all* its waste
# values are special-purpose, so "trash;dog_excrement" stays eligible.
INELIGIBLE_WASTE = {"sharps", "dog_excrement"}
INELIGIBLE_ACCESS = {"private", "no"}
# Refuse to mark more than this share of the active OSM bins as removed at once
# (protects against importing a truncated or wrong file).
MAX_REMOVAL_FRACTION = 0.5


class BinImportError(Exception):
    """Raised when the input or the planned changes are not acceptable."""


@dataclass(frozen=True)
class BinRow:
    osm_type: str
    osm_id: int
    lon: float
    lat: float
    tags: dict
    eligible: bool


@dataclass(frozen=True)
class ImportResult:
    total: int
    inserted: int
    updated: int
    removed: int

    @property
    def unchanged(self) -> int:
        return self.total - self.inserted - self.updated


def split_values(value: str) -> set[str]:
    """OSM multi-value tags are ';'-separated."""
    return {v.strip().lower() for v in value.split(";") if v.strip()}


def is_eligible(tags: dict) -> bool:
    if split_values(tags.get("access", "")) & INELIGIBLE_ACCESS:
        return False
    waste = split_values(tags.get("waste", ""))
    if waste and waste <= INELIGIBLE_WASTE:
        return False
    return True


def parse_features(collection: dict) -> list[BinRow]:
    if collection.get("type") != "FeatureCollection":
        raise BinImportError("input is not a GeoJSON FeatureCollection")
    rows: list[BinRow] = []
    seen: set[tuple[str, int]] = set()
    for index, feature in enumerate(collection.get("features", [])):
        where = f"feature {index} ({feature.get('id', '?')})"
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        osm_type, osm_id = props.get("osm_type"), props.get("osm_id")
        if osm_type not in OSM_TYPES:
            raise BinImportError(f"{where}: invalid osm_type {osm_type!r}")
        if not isinstance(osm_id, int) or isinstance(osm_id, bool) or osm_id <= 0:
            raise BinImportError(f"{where}: invalid osm_id {osm_id!r}")
        if geometry.get("type") != "Point":
            raise BinImportError(f"{where}: geometry must be a Point")
        lon, lat = (float(c) for c in geometry["coordinates"][:2])
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise BinImportError(f"{where}: coordinates out of range")
        if (osm_type, osm_id) in seen:
            raise BinImportError(f"{where}: duplicate {osm_type}/{osm_id}")
        seen.add((osm_type, osm_id))
        tags = props.get("tags") or {}
        rows.append(BinRow(osm_type, osm_id, lon, lat, tags, is_eligible(tags)))
    return rows


def import_bins(conn, rows: list[BinRow], *, allow_mass_removal: bool = False) -> ImportResult:
    """Apply the import inside the caller's transaction (does not commit)."""
    if not rows:
        raise BinImportError("no bins in input, refusing to mark every bin as removed")

    with conn.cursor() as cur:
        cur.execute("drop table if exists pg_temp.bins_import")
        cur.execute("""
            create temp table bins_import (
              osm_type text not null,
              osm_id bigint not null,
              lon double precision not null,
              lat double precision not null,
              tags jsonb not null,
              eligible boolean not null,
              primary key (osm_type, osm_id)
            )
        """)
        with cur.copy("copy bins_import (osm_type, osm_id, lon, lat, tags, eligible) from stdin") as copy:
            for r in rows:
                copy.write_row((r.osm_type, r.osm_id, r.lon, r.lat, json.dumps(r.tags, ensure_ascii=False), r.eligible))

        cur.execute("""
            select count(*) filter (where b.status <> 'removed'),
                   count(*) filter (where b.status <> 'removed' and i.osm_id is null)
            from public.bins b
            left join bins_import i on i.osm_type = b.osm_type and i.osm_id = b.osm_id
            where b.source = 'osm'
        """)
        active, to_remove = cur.fetchone()
        if not allow_mass_removal and active >= 10 and to_remove > active * MAX_REMOVAL_FRACTION:
            raise BinImportError(
                f"import would remove {to_remove} of {active} active OSM bins; "
                "check the input file or pass --allow-mass-removal"
            )

        cur.execute("""
            with upserted as (
              insert into public.bins as b (osm_type, osm_id, geom, tags, eligible, source, status)
              select i.osm_type, i.osm_id,
                     extensions.st_setsrid(extensions.st_makepoint(i.lon, i.lat), 4326)::extensions.geography,
                     i.tags, i.eligible, 'osm', 'active'
              from bins_import i
              on conflict (osm_type, osm_id) do update
                set geom = excluded.geom,
                    tags = excluded.tags,
                    eligible = excluded.eligible,
                    status = 'active'
                where extensions.st_asbinary(b.geom) is distinct from extensions.st_asbinary(excluded.geom)
                   or b.tags is distinct from excluded.tags
                   or b.eligible is distinct from excluded.eligible
                   or b.status is distinct from 'active'
              returning (b.xmax = 0) as inserted
            )
            select count(*) filter (where inserted), count(*) filter (where not inserted) from upserted
        """)
        inserted, updated = cur.fetchone()

        cur.execute("""
            update public.bins b
               set status = 'removed'
             where b.source = 'osm'
               and b.status <> 'removed'
               and not exists (
                 select 1 from bins_import i where i.osm_type = b.osm_type and i.osm_id = b.osm_id
               )
        """)
        removed = cur.rowcount
        cur.execute("drop table bins_import")

    return ImportResult(total=len(rows), inserted=inserted, updated=updated, removed=removed)


check_local = devenv.require_local


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", type=Path, default=DEFAULT_FILE, help="GeoJSON input (default: data/bins.geojson)")
    parser.add_argument("--dry-run", action="store_true", help="run the import and roll it back")
    parser.add_argument("--allow-mass-removal", action="store_true",
                        help=f"allow marking more than {MAX_REMOVAL_FRACTION * 100:.0f}%% of the active OSM bins as removed")
    parser.add_argument("--allow-remote", action="store_true", help="allow a non-local DATABASE_URL")
    args = parser.parse_args(argv)

    import psycopg  # imported lazily so the pure helpers can be tested without it

    devenv.load_env_file()
    url = devenv.database_url()
    check_local(url, args.allow_remote)
    if not args.file.exists():
        sys.exit(f"{args.file} not found, run scripts/osm/osm_bins.py first")

    try:
        rows = parse_features(json.loads(args.file.read_text(encoding="utf-8")))
        with psycopg.connect(url) as conn:
            result = import_bins(conn, rows, allow_mass_removal=args.allow_mass_removal)
            if args.dry_run:
                conn.rollback()
            else:
                conn.commit()
    except BinImportError as error:
        sys.exit(f"Import aborted: {error}")
    except psycopg.OperationalError as error:
        sys.exit(f"Cannot connect to the database ({error}). Is Supabase running (npm run db:start)?")

    ineligible = [r for r in rows if not r.eligible]
    print(f"Import{' (dry run, rolled back)' if args.dry_run else ''}: {result.total} bins in "
          f"{args.file.name} ({result.total - len(ineligible)} eligible, {len(ineligible)} not eligible)")
    print(f"  inserted {result.inserted}, updated {result.updated}, unchanged {result.unchanged}, "
          f"marked removed {result.removed}")
    for r in ineligible:
        reason = {k: r.tags[k] for k in ("waste", "access") if k in r.tags}
        print(f"  not eligible: {r.osm_type}/{r.osm_id} {reason}")


if __name__ == "__main__":
    main()
