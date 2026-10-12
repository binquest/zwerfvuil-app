#!/usr/bin/env python3
"""OSM pipeline for the test region around Oude Houtlei, Gent.

Steps (run from anywhere, paths are resolved from the repo root):
    region    Geocode the street via Nominatim, buffer it and write config/region.json
    download  Fetch belgium-latest.osm.pbf from Geofabrik into data/ (cached for 7 days)
    extract   Filter amenity=waste_basket inside the region bbox into data/bins.geojson
    all       region (cached) + download (cached) + extract

Examples:
    python scripts/osm/osm_bins.py all
    python scripts/osm/osm_bins.py region --refresh
    python scripts/osm/osm_bins.py download --force
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import devenv  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REGION_PATH = ROOT / "config" / "region.json"
DATA_DIR = ROOT / "data"
PBF_URL = "https://download.geofabrik.de/europe/belgium-latest.osm.pbf"
PBF_PATH = DATA_DIR / "belgium-latest.osm.pbf"
BINS_PATH = DATA_DIR / "bins.geojson"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
REGION_NAME = "Oude Houtlei, Gent"
STREET_NAME = "Oude Houtlei"
CITY_NAME = "Gent"
BUFFER_M = 600
# Sanity check from the brief: the region centre lies roughly here (lat, lon).
EXPECTED_CENTER = (51.056, 3.714)
MAX_CENTER_DEVIATION_M = 750

PBF_MAX_AGE_DAYS = 7
BIN_TAG = ("amenity", "waste_basket")
COORD_DECIMALS = 7  # OSM stores coordinates with 7 decimals

MIN_REQUEST_INTERVAL_S = 1.0  # Nominatim: max 1 request per second


def user_agent() -> str:
    """Nominatim usage policy: identify the application. OSM_CONTACT (shell or the
    repo-root .env; an email address or URL) adds a contact."""
    contact = os.environ.get("OSM_CONTACT", "").strip()
    return "zwerfvuil-app-mvp/0.1 (Gent test region import" + (f"; {contact})" if contact else ")")


_last_request_at = 0.0


# --------------------------------------------------------------------------
# Geometry helpers (pure functions, unit tested in test_osm_bins.py)
# --------------------------------------------------------------------------

Point = tuple[float, float]  # (lon, lat)


def iter_positions(geometry: dict):
    """Yield every (lon, lat) position of a GeoJSON geometry."""

    def walk(coords):
        if coords and isinstance(coords[0], (int, float)):
            yield (float(coords[0]), float(coords[1]))
        else:
            for c in coords:
                yield from walk(c)

    if geometry["type"] == "GeometryCollection":
        for g in geometry["geometries"]:
            yield from iter_positions(g)
    else:
        yield from walk(geometry["coordinates"])


def bounds(points) -> dict:
    lons, lats = zip(*points)
    return {"west": min(lons), "south": min(lats), "east": max(lons), "north": max(lats)}


def meters_per_degree(lat: float) -> tuple[float, float]:
    """Meters per degree of (latitude, longitude) at the given latitude (WGS84)."""
    phi = math.radians(lat)
    m_lat = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    m_lon = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)
    return m_lat, m_lon


def buffer_bbox(bbox: dict, meters: float, decimals: int = 6) -> dict:
    """Grow a bbox by `meters` on every side, rounding outwards."""
    m_lat, _ = meters_per_degree((bbox["south"] + bbox["north"]) / 2)
    d_lat = meters / m_lat
    # Use the latitude furthest from the equator: fewest meters per degree of
    # longitude there, so the buffer is at least `meters` everywhere.
    edge_lat = max(abs(bbox["south"] - d_lat), abs(bbox["north"] + d_lat))
    _, m_lon = meters_per_degree(edge_lat)
    d_lon = meters / m_lon
    f = 10**decimals
    return {
        "west": math.floor((bbox["west"] - d_lon) * f) / f,
        "south": math.floor((bbox["south"] - d_lat) * f) / f,
        "east": math.ceil((bbox["east"] + d_lon) * f) / f,
        "north": math.ceil((bbox["north"] + d_lat) * f) / f,
    }


def bbox_center(bbox: dict) -> Point:
    return ((bbox["west"] + bbox["east"]) / 2, (bbox["south"] + bbox["north"]) / 2)


def in_bbox(bbox: dict, point: Point) -> bool:
    lon, lat = point
    return bbox["west"] <= lon <= bbox["east"] and bbox["south"] <= lat <= bbox["north"]


def haversine_m(a: Point, b: Point) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def mean_point(points: list[Point]) -> Point:
    return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))


def ring_centroid(ring: list[Point]) -> tuple[Point, float] | None:
    """Area centroid and absolute area (in deg²) of a closed ring, None if degenerate.

    The centroid is affine-invariant, so computing it in plain lon/lat gives the
    same point as in a local planar projection. Coordinates are shifted to the
    first vertex to avoid floating point cancellation.
    """
    if len(ring) < 4:
        return None
    ox, oy = ring[0]
    area2 = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        x0, y0, x1, y1 = x0 - ox, y0 - oy, x1 - ox, y1 - oy
        cross = x0 * y1 - x1 * y0
        area2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if abs(area2) < 1e-14:
        return None
    return (ox + cx / (3 * area2), oy + cy / (3 * area2)), abs(area2) / 2


def line_centroid(points: list[Point]) -> Point:
    """Length-weighted centroid of a polyline; vertex mean if it has no length."""
    total = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        length = math.hypot(x1 - x0, y1 - y0)
        total += length
        cx += (x0 + x1) / 2 * length
        cy += (y0 + y1) / 2 * length
    if total == 0:
        return mean_point(points)
    return (cx / total, cy / total)


def way_centroid(points: list[Point], closed: bool) -> Point:
    """Polygon centroid for closed ways, line centroid for open ones."""
    if closed:
        result = ring_centroid(points)
        if result:
            return result[0]
    return line_centroid(points)


def relation_centroid(ways: list[tuple[str, list[Point], bool]], nodes: list[Point]) -> Point | None:
    """Centroid of a relation from its member ways (role, points, closed) and nodes.

    Uses the area-weighted centroid of closed outer rings, then falls back to the
    length-weighted centroid of all member ways, then to the mean of member nodes.
    """
    rings = [ring_centroid(pts) for role, pts, closed in ways if closed and role in ("outer", "")]
    rings = [r for r in rings if r]
    if rings:
        total = sum(area for _, area in rings)
        return (
            sum(c[0] * area for c, area in rings) / total,
            sum(c[1] * area for c, area in rings) / total,
        )
    segments = [line_centroid(pts) for _, pts, _ in ways if pts]
    if segments:
        lengths = [max(sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])), 1e-12)
                   for _, pts, _ in ways if pts]
        total = sum(lengths)
        return (
            sum(c[0] * w for c, w in zip(segments, lengths)) / total,
            sum(c[1] * w for c, w in zip(segments, lengths)) / total,
        )
    if nodes:
        return mean_point(nodes)
    return None


def round_point(point: Point) -> list[float]:
    return [round(point[0], COORD_DECIMALS), round(point[1], COORD_DECIMALS)]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def http_get(url: str):
    """GET with an identifying User-Agent and at most one request per second."""
    global _last_request_at
    wait = _last_request_at + MIN_REQUEST_INTERVAL_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": user_agent()})
    try:
        return urllib.request.urlopen(request, timeout=60)
    finally:
        _last_request_at = time.monotonic()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------
# Step 1: region
# --------------------------------------------------------------------------


def load_region() -> dict:
    if not REGION_PATH.exists():
        sys.exit(f"{REGION_PATH.relative_to(ROOT)} not found, run the 'region' step first")
    return json.loads(REGION_PATH.read_text(encoding="utf-8"))


def street_lines(geometry: dict) -> list[list[Point]]:
    if geometry["type"] == "LineString":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiLineString":
        return geometry["coordinates"]
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"][0]]
    if geometry["type"] == "MultiPolygon":
        return [poly[0] for poly in geometry["coordinates"]]
    return []


def cmd_region(args) -> dict:
    if REGION_PATH.exists() and not args.refresh:
        region = load_region()
        print(f"Region: using cached {REGION_PATH.relative_to(ROOT)} (fetched {region['source']['fetched_at']}, "
              "use --refresh to geocode again)")
        return region

    params = {
        "q": REGION_NAME,
        "format": "geojson",
        "polygon_geojson": 1,
        "addressdetails": 1,
        "dedupe": 0,  # return every way segment of the street, not just one
        "countrycodes": "be",
        "accept-language": "nl",
        "limit": 20,
    }
    url = f"{NOMINATIM_URL}?{urllib.parse.urlencode(params)}"
    print(f"Region: querying Nominatim for '{REGION_NAME}'")
    with http_get(url) as response:
        data = json.load(response)

    features = [
        f for f in data.get("features", [])
        if f["properties"].get("category") == "highway"
        and f["properties"].get("name") == STREET_NAME
        and CITY_NAME in (f["properties"].get("address") or {}).values()
    ]
    if not features:
        sys.exit(f"Nominatim returned no highway named '{STREET_NAME}' in {CITY_NAME}")

    positions = [p for f in features for p in iter_positions(f["geometry"])]
    street_bbox = bounds(positions)
    bbox = buffer_bbox(street_bbox, BUFFER_M)
    center_lon, center_lat = bbox_center(bbox)

    deviation = haversine_m((center_lon, center_lat), (EXPECTED_CENTER[1], EXPECTED_CENTER[0]))
    if deviation > MAX_CENTER_DEVIATION_M:
        sys.exit(f"Region centre {center_lat:.5f}, {center_lon:.5f} is {deviation:.0f} m from the expected "
                 f"{EXPECTED_CENTER[0]}, {EXPECTED_CENTER[1]}; refusing to write a suspicious region")

    lines = [[round_point(p) for p in line] for f in features for line in street_lines(f["geometry"])]
    region = {
        "name": REGION_NAME,
        "buffer_m": BUFFER_M,
        "center": {"lat": round(center_lat, 6), "lon": round(center_lon, 6)},
        "bbox": bbox,
        "street": {
            "name": STREET_NAME,
            "bbox": {k: round(v, COORD_DECIMALS) for k, v in street_bbox.items()},
            "geometry": {"type": "MultiLineString", "coordinates": lines},
        },
        "source": {
            "provider": "Nominatim / OpenStreetMap",
            "query": REGION_NAME,
            "osm_ids": sorted(f"{f['properties']['osm_type']}/{f['properties']['osm_id']}" for f in features),
            "fetched_at": utc_now(),
            "attribution": "© OpenStreetMap contributors, ODbL",
        },
    }
    REGION_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGION_PATH.write_text(json.dumps(region, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Region: {len(features)} street segment(s), centre {center_lat:.5f}, {center_lon:.5f} "
          f"({deviation:.0f} m from expected), written to {REGION_PATH.relative_to(ROOT)}")
    return region


# --------------------------------------------------------------------------
# Step 2: download
# --------------------------------------------------------------------------


def fetch_expected_md5() -> str:
    with http_get(PBF_URL + ".md5") as response:
        return response.read().decode("ascii").split()[0].lower()


def download_with_md5(url: str, dest: Path) -> str:
    digest = hashlib.md5()
    with http_get(url) as response, dest.open("wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        done, next_report, started = 0, 0.0, time.monotonic()
        while chunk := response.read(1 << 20):
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if total and done / total >= next_report:
                speed = done / max(time.monotonic() - started, 1e-6) / 1e6
                print(f"  {done / 1e6:7.1f} / {total / 1e6:.1f} MB ({done / total:4.0%}, {speed:.1f} MB/s)", flush=True)
                next_report += 0.1
    return digest.hexdigest()


def cmd_download(args) -> None:
    rel = PBF_PATH.relative_to(ROOT)
    if PBF_PATH.exists() and not args.force:
        age_days = (time.time() - PBF_PATH.stat().st_mtime) / 86400
        if age_days < PBF_MAX_AGE_DAYS:
            print(f"Download: using cached {rel} ({age_days:.1f} days old, "
                  f"limit {PBF_MAX_AGE_DAYS}; use --force to download again)")
            return
        print(f"Download: {rel} is {age_days:.1f} days old, downloading a fresh copy")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    part = PBF_PATH.with_name(PBF_PATH.name + ".part")
    # Geofabrik replaces the file daily; if the checksum changes mid-download, retry once.
    for attempt in (1, 2):
        expected = fetch_expected_md5()
        print(f"Download: {PBF_URL} (attempt {attempt}, expected md5 {expected})")
        actual = download_with_md5(PBF_URL, part)
        if actual == expected:
            os.replace(part, PBF_PATH)
            print(f"Download: md5 OK, saved {rel} ({PBF_PATH.stat().st_size / 1e6:.1f} MB)")
            return
        print(f"Download: md5 mismatch (got {actual}), retrying")
    part.unlink(missing_ok=True)
    sys.exit("Download failed: checksum mismatch twice")


# --------------------------------------------------------------------------
# Step 3: extract
# --------------------------------------------------------------------------

TYPE_NAMES = {"n": "node", "w": "way", "r": "relation"}
TYPE_ORDER = {"node": 0, "way": 1, "relation": 2}


def object_base(obj, osm_type: str) -> dict:
    timestamp = obj.timestamp
    return {
        "osm_type": osm_type,
        "osm_id": obj.id,
        "tags": {t.k: t.v for t in obj.tags},
        "osm_version": obj.version,
        "osm_timestamp": timestamp.isoformat().replace("+00:00", "Z") if timestamp.year > 1970 else None,
    }


def cmd_extract(args) -> dict:
    import osmium  # imported lazily so the geometry helpers can be tested without it

    region = load_region()
    bbox = region["bbox"]
    if not PBF_PATH.exists():
        sys.exit(f"{PBF_PATH.relative_to(ROOT)} not found, run the 'download' step first")

    started = time.monotonic()
    pbf = str(PBF_PATH)
    replication_ts = osmium.FileProcessor(pbf).header.get("osmosis_replication_timestamp")

    # Pass 1: every object tagged amenity=waste_basket (tag filter runs in C++).
    nodes, ways, relations = [], [], []
    tagged = Counter()
    for obj in osmium.FileProcessor(pbf).with_filter(osmium.filter.TagFilter(BIN_TAG)):
        if obj.is_node():
            tagged["node"] += 1
            if obj.location.valid():
                point = (obj.location.lon, obj.location.lat)
                if in_bbox(bbox, point):
                    nodes.append(object_base(obj, "node") | {"point": point})
        elif obj.is_way():
            tagged["way"] += 1
            ways.append(object_base(obj, "way") | {"refs": [n.ref for n in obj.nodes]})
        elif obj.is_relation():
            tagged["relation"] += 1
            members = [(m.type, m.ref, m.role) for m in obj.members]
            relations.append(object_base(obj, "relation") | {"members": members})
    print(f"Extract: pass 1 found {sum(tagged.values())} {BIN_TAG[0]}={BIN_TAG[1]} objects in Belgium "
          f"({dict(tagged)}) in {time.monotonic() - started:.0f} s")

    # Pass 2: node lists of ways that are members of tagged relations.
    member_way_ids = {ref for r in relations for t, ref, _ in r["members"] if t == "w"}
    member_way_refs: dict[int, list[int]] = {}
    if member_way_ids:
        for way in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.IdFilter(member_way_ids)):
            member_way_refs[way.id] = [n.ref for n in way.nodes]

    # Pass 3: locations of every node we need for centroids.
    needed = {ref for w in ways for ref in w["refs"]}
    needed |= {ref for refs in member_way_refs.values() for ref in refs}
    needed |= {ref for r in relations for t, ref, _ in r["members"] if t == "n"}
    locations: dict[int, Point] = {}
    if needed:
        for node in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(needed)):
            if node.location.valid():
                locations[node.id] = (node.location.lon, node.location.lat)

    features = []

    def add(item: dict, point: Point, geometry_source: str) -> None:
        if not in_bbox(bbox, point):
            return
        props = {k: v for k, v in item.items() if k not in ("point", "refs", "members")}
        props["geometry_source"] = geometry_source
        features.append({
            "type": "Feature",
            "id": f"{item['osm_type']}/{item['osm_id']}",
            "geometry": {"type": "Point", "coordinates": round_point(point)},
            "properties": props,
        })

    for node in nodes:
        add(node, node["point"], "node")

    for way in ways:
        points = [locations[r] for r in way["refs"] if r in locations]
        if not points:
            print(f"  warning: way/{way['osm_id']} has no node locations, skipped")
            continue
        closed = len(way["refs"]) >= 4 and way["refs"][0] == way["refs"][-1]
        add(way, way_centroid(points, closed), "way_centroid")

    for rel in relations:
        member_ways, member_nodes = [], []
        for t, ref, role in rel["members"]:
            if t == "w" and ref in member_way_refs:
                refs = member_way_refs[ref]
                pts = [locations[r] for r in refs if r in locations]
                member_ways.append((role, pts, len(refs) >= 4 and refs[0] == refs[-1]))
            elif t == "n" and ref in locations:
                member_nodes.append(locations[ref])
        point = relation_centroid(member_ways, member_nodes)
        if point is None:
            print(f"  warning: relation/{rel['osm_id']} has no resolvable geometry, skipped")
            continue
        add(rel, point, "relation_centroid")

    features.sort(key=lambda f: (TYPE_ORDER[f["properties"]["osm_type"]], f["properties"]["osm_id"]))
    collection = {
        "type": "FeatureCollection",
        "bbox": [bbox["west"], bbox["south"], bbox["east"], bbox["north"]],
        "metadata": {
            "region": region["name"],
            "filter": f"{BIN_TAG[0]}={BIN_TAG[1]}",
            "generated_at": utc_now(),
            "source_url": PBF_URL,
            "source_replication_timestamp": replication_ts,
            "attribution": "© OpenStreetMap contributors, ODbL",
        },
        "features": features,
    }
    BINS_PATH.parent.mkdir(parents=True, exist_ok=True)
    BINS_PATH.write_text(json.dumps(collection, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    per_type = Counter(f["properties"]["osm_type"] for f in features)
    print()
    print(f"Waste baskets in region '{region['name']}': {len(features)}")
    print(f"  bbox (W,S,E,N): {bbox['west']}, {bbox['south']}, {bbox['east']}, {bbox['north']}")
    print(f"  centre: {region['center']['lat']}, {region['center']['lon']} (buffer {region['buffer_m']} m)")
    print("  per OSM type: " + ", ".join(f"{t} {per_type.get(t, 0)}" for t in TYPE_ORDER))
    print(f"  OSM data timestamp: {replication_ts}")
    print(f"  written to {BINS_PATH.relative_to(ROOT)} in {time.monotonic() - started:.0f} s")
    return collection


def cmd_all(args) -> None:
    args.refresh = getattr(args, "refresh", False)
    args.force = getattr(args, "force", False)
    cmd_region(args)
    cmd_download(args)
    cmd_extract(args)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("region", help="geocode the street and write config/region.json")
    p.add_argument("--refresh", action="store_true", help="query Nominatim even if region.json exists")
    p.set_defaults(func=cmd_region)
    p = sub.add_parser("download", help="download the Belgium PBF from Geofabrik")
    p.add_argument("--force", action="store_true", help="download even if the cached file is recent")
    p.set_defaults(func=cmd_download)
    p = sub.add_parser("extract", help="extract waste baskets into data/bins.geojson")
    p.set_defaults(func=cmd_extract)
    p = sub.add_parser("all", help="run region, download and extract")
    p.add_argument("--refresh", action="store_true", help="query Nominatim even if region.json exists")
    p.add_argument("--force", action="store_true", help="download even if the cached file is recent")
    p.set_defaults(func=cmd_all)
    args = parser.parse_args(argv)
    devenv.load_env_file()
    args.func(args)


if __name__ == "__main__":
    main()
