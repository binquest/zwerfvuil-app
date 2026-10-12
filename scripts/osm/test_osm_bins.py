"""Unit tests for the geometry helpers in osm_bins.py.

Run from the repo root: python -m unittest discover -s scripts/osm
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import osm_bins as ob  # noqa: E402

GENT = (3.714, 51.056)


def square(origin, size):
    x, y = origin
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size), (x, y)]


class CentroidTests(unittest.TestCase):
    def assertPointAlmostEqual(self, a, b, places=9):
        self.assertAlmostEqual(a[0], b[0], places=places)
        self.assertAlmostEqual(a[1], b[1], places=places)

    def test_square_centroid_near_gent(self):
        # A ~5 m square: tiny areas at large coordinates must not lose precision.
        size = 0.00005
        centroid, area = ob.ring_centroid(square(GENT, size))
        self.assertPointAlmostEqual(centroid, (GENT[0] + size / 2, GENT[1] + size / 2), places=10)
        self.assertAlmostEqual(area, size * size, places=15)

    def test_ring_orientation_does_not_matter(self):
        ring = square(GENT, 0.001)
        self.assertPointAlmostEqual(ob.ring_centroid(ring)[0], ob.ring_centroid(ring[::-1])[0])

    def test_l_shape_centroid_is_area_weighted(self):
        # L-shape made of a 2x1 and a 1x1 block: centroid is not the vertex mean.
        ring = [(0, 0), (2, 0), (2, 1), (1, 1), (1, 2), (0, 2), (0, 0)]
        centroid, area = ob.ring_centroid(ring)
        self.assertPointAlmostEqual(centroid, (5 / 6, 5 / 6))
        self.assertAlmostEqual(area, 3)

    def test_degenerate_ring_returns_none(self):
        self.assertIsNone(ob.ring_centroid([(0, 0), (1, 1), (2, 2), (0, 0)]))
        self.assertIsNone(ob.ring_centroid([(0, 0), (1, 1), (0, 0)]))

    def test_line_centroid_is_length_weighted(self):
        # Long segment 0..2 and short segment 2..2.5 on the x axis.
        self.assertPointAlmostEqual(ob.line_centroid([(0, 0), (2, 0), (2.5, 0)]), (1.25, 0))

    def test_line_centroid_zero_length_falls_back_to_mean(self):
        self.assertPointAlmostEqual(ob.line_centroid([(1, 1), (1, 1)]), (1, 1))

    def test_way_centroid_closed_and_open(self):
        ring = square((0, 0), 2)
        self.assertPointAlmostEqual(ob.way_centroid(ring, closed=True), (1, 1))
        self.assertPointAlmostEqual(ob.way_centroid([(0, 0), (2, 0)], closed=False), (1, 0))

    def test_way_centroid_degenerate_closed_way_uses_line(self):
        ring = [(0, 0), (2, 0), (1, 0), (0, 0)]
        self.assertPointAlmostEqual(ob.way_centroid(ring, closed=True), (1, 0))

    def test_relation_centroid_prefers_outer_rings_weighted_by_area(self):
        big = ("outer", square((0, 0), 2), True)  # area 4, centroid (1, 1)
        small = ("outer", square((10, 0), 1), True)  # area 1, centroid (10.5, 0.5)
        line = ("", [(100, 100), (101, 100)], False)
        result = ob.relation_centroid([big, small, line], [(50, 50)])
        self.assertPointAlmostEqual(result, ((4 * 1 + 1 * 10.5) / 5, (4 * 1 + 1 * 0.5) / 5))

    def test_relation_centroid_fallbacks(self):
        self.assertPointAlmostEqual(ob.relation_centroid([("", [(0, 0), (2, 0)], False)], []), (1, 0))
        self.assertPointAlmostEqual(ob.relation_centroid([], [(0, 0), (2, 2)]), (1, 1))
        self.assertIsNone(ob.relation_centroid([], []))


class BboxTests(unittest.TestCase):
    def test_buffer_bbox_grows_at_least_the_buffer_on_every_side(self):
        street = {"west": 3.71, "south": 51.054, "east": 3.716, "north": 51.058}
        buffered = ob.buffer_bbox(street, 600)
        mid_lat = (street["south"] + street["north"]) / 2
        mid_lon = (street["west"] + street["east"]) / 2
        north = ob.haversine_m((mid_lon, street["north"]), (mid_lon, buffered["north"]))
        south = ob.haversine_m((mid_lon, street["south"]), (mid_lon, buffered["south"]))
        west = ob.haversine_m((street["west"], buffered["north"]), (buffered["west"], buffered["north"]))
        east = ob.haversine_m((street["east"], mid_lat), (buffered["east"], mid_lat))
        # buffer_bbox uses the WGS84 ellipsoid, haversine a sphere: at 51° N they
        # differ by ~0.3% east-west, so allow a 0.5% tolerance.
        for side in (north, south, west, east):
            self.assertGreater(side, 597)
            self.assertLess(side, 603)

    def test_in_bbox_is_inclusive(self):
        bbox = {"west": 0, "south": 0, "east": 1, "north": 1}
        self.assertTrue(ob.in_bbox(bbox, (0, 0)))
        self.assertTrue(ob.in_bbox(bbox, (1, 1)))
        self.assertFalse(ob.in_bbox(bbox, (1.0000001, 0.5)))

    def test_bounds_and_iter_positions(self):
        geometry = {"type": "MultiLineString", "coordinates": [[[3, 51], [4, 52]], [[2.5, 51.5], [3.5, 50.5]]]}
        self.assertEqual(ob.bounds(ob.iter_positions(geometry)),
                         {"west": 2.5, "south": 50.5, "east": 4, "north": 52})

    def test_haversine_one_degree_latitude(self):
        self.assertAlmostEqual(ob.haversine_m((0, 0), (0, 1)), 111195, delta=5)


if __name__ == "__main__":
    unittest.main()
