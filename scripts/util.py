"""Shared utilities for BioEco Elasticsearch data loaders."""
from __future__ import annotations

from elasticsearch import BadRequestError, NotFoundError
from elasticsearch.helpers import bulk
from shapely import wkt, buffer, MultiPolygon
from shapely.geometry import mapping, LineString, Polygon, shape
from shapely.ops import split as split_geom, transform, unary_union
from shapely.validation import make_valid
import logging
from polygon_geohasher.polygon_geohasher import polygon_to_geohashes
import geohash
import uuid
from datetime import datetime
from pathlib import Path
import json
import copy
from collections import defaultdict

try:
    import antimeridian
except Exception:
    antimeridian = None

project_index = "project"
grid_index = "project_grid"

# Colored log helpers for clear ingest diagnostics in terminal output.
ANSI_RESET = "\033[0m"
ANSI_RED = "\033[31m"
ANSI_YELLOW = "\033[33m"
ANSI_GREEN = "\033[32m"
ANSI_CYAN = "\033[36m"


def color_text(text: str, color: str) -> str:
    return f"{color}{text}{ANSI_RESET}"


def log_colored(level: str, label: str, message: str):
    color = {
        "INFO": ANSI_CYAN,
        "OK": ANSI_GREEN,
        "WARN": ANSI_YELLOW,
        "ERROR": ANSI_RED,
    }.get(level, ANSI_CYAN)
    logging.info("%s %s", color_text(f"[{label}]", color), message)

# Path to repo root and data dir
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def ensure_indices(client, clear_indexes: bool = False):
    """Create indices and mappings. Optionally clear existing indices first."""
    project_mapping = {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "uri": {"type": "keyword"},
                "name": {
                    "type": "text",
                    "fields": {
                        "keyword": {"type": "keyword"}
                    }
                },
                "description": {"type": "text"},
                "temporal_coverage": {"type": "date"},
                "start_date": {"type": "date"},
                "end_date": {"type": "date"},
                "start_year": {"type": "integer"},
                "end_year": {"type": "integer"},
                "url": {"type": "keyword"},
                "keywords": {"type": "keyword"},
                "eovs": {
                    "type": "nested",
                    "properties": {
                        "uri": {"type": "keyword"},
                        "label": {
                            "type": "text",
                            "fields": {"keyword": {"type": "keyword"}}
                        },
                        "code": {"type": "keyword"}
                    }
                },
                "eov_keywords": {"type": "keyword"},
                "eov_codes": {"type": "keyword"},
                "readiness_data": {"type": "keyword"},
                "readiness_requirements": {"type": "keyword"},
                "readiness_coordination": {"type": "keyword"},
                "maintenance_frequency": {"type": "keyword"},
                "publishing_principles": {"type": "keyword"},
                "funding_categories": {"type": "keyword"},
                "funding_descriptions": {"type": "text"},
                "additional_properties": {
                    "type": "nested",
                    "properties": {
                        "name": {"type": "keyword"},
                        "value": {"type": "keyword"}
                    }
                },
                "contacts": {
                    "type": "nested",
                    "properties": {
                        "name": {"type": "keyword"},
                        "email": {"type": "keyword"},
                        "url": {"type": "keyword"},
                        "contact_type": {"type": "keyword"}
                    }
                },
                "services": {
                    "type": "nested",
                    "properties": {
                        "name": {"type": "keyword"},
                        "url": {"type": "keyword"}
                    }
                },
                "geometry": {"type": "geo_shape"}
            }
        }
    }

    grid_mapping = {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "project": {"type": "text"},
                "eov_codes": {"type": "keyword"},
                "eov_keywords": {"type": "keyword"},
                "start_year": {"type": "integer"},
                "end_year": {"type": "integer"},
                "geometry": {"type": "geo_point"}
            }
        }
    }

    for index, mapping in ((project_index, project_mapping), (grid_index, grid_mapping)):
        exists = client.indices.exists(index=index)
        if clear_indexes and exists:
            logging.info("Deleting existing index %s", index)
            client.indices.delete(index=index)
            exists = False
        if not exists:
            logging.info("Creating index %s with mapping", index)
            client.indices.create(index=index, body=mapping)
            client.indices.put_settings(
                index=index,
                body={
                    "index": {
                        "refresh_interval": "30s"
                    }
                },
            )

# Load EOV vocabulary for resolving URIs to top-level and subvariable codes

def load_eov_vocabulary():
    path = DATA_DIR / "eov_vocabulary.json"
    if not path.exists():
        logging.warning("EOV vocabulary not found at %s; eov_keywords and eov_codes will be empty.", path)
        return {"top_level_eovs": [], "subvariables": []}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_eov_lookups(vocab):
    """Build URI lookups:
    - url_map: any known URI (canonical or alternative) -> (top_level_code, eov_code)
    - sorted_urls: URIs sorted by length (desc) for prefix matching
    - canonical_uri_map: any known URI -> canonical EOV URI (from vocabulary url)
    """
    top_level = vocab.get("top_level_eovs", [])
    subvars = vocab.get("subvariables", [])
    url_map = {}  # uri -> (top_level_code, eov_code)
    canonical_uri_map = {}
    # Subvariables first (longer URLs), so we can match .../fish/abundance before .../fish
    for s in subvars:
        code = s.get("code")
        parent = s.get("parent_code")
        if not code or not parent:
            continue
        url = (s.get("url") or "").strip()
        if url:
            url_map[url] = (parent, code)
            canonical_uri_map[url] = url
        # Alternate URIs for subvariables
        for alt in (s.get("alt_uris") or []):
            if alt:
                a = alt.strip()
                url_map[a] = (parent, code)
                canonical_uri_map[a] = url
    for t in top_level:
        code = t.get("code")
        if not code:
            continue
        url = (t.get("url") or "").strip()
        if url:
            if url not in url_map:
                url_map[url] = (code, code)
            canonical_uri_map[url] = url
        # Alternate URIs for top-level EOVs
        for alt in (t.get("alt_uris") or []):
            if alt:
                a = alt.strip()
                if a not in url_map:
                    url_map[a] = (code, code)
                canonical_uri_map[a] = url
    # Prefix match: sort by URL length descending so longest match wins
    sorted_urls = sorted(url_map.keys(), key=len, reverse=True)
    return url_map, sorted_urls, canonical_uri_map


vocab = load_eov_vocabulary()
url_map, url_prefix_order, canonical_uri_map = build_eov_lookups(vocab)

# App export URLs that differ from GOOS vocabulary paths (handled before lookup).
_EOV_URI_PREFIX_ALIASES = (
    ("https://goosocean.org/eov/macroalgae", "https://goosocean.org/eov/macroalgal"),
    ("https://goosocean.org/eov/invertebrates", "https://goosocean.org/eov/invertebrate"),
    ("https://goosocean.org/eov/microbes", "https://goosocean.org/eov/microbe"),
)


def normalize_eov_uri(uri: str) -> str:
    """Map common EOV metadata app URL variants onto vocabulary URLs."""
    u = (uri or "").strip().rstrip("/")
    if not u:
        return u
    for src, dst in _EOV_URI_PREFIX_ALIASES:
        if u == src:
            return dst
        if u.startswith(src + "/"):
            return dst + u[len(src) :]
    return u


def resolve_eov_uri(uri: str):
    """Resolve a project EOV URI to (top_level_code, eov_code) or (None, None)."""
    if not uri or not url_map:
        return (None, None)
    uri = normalize_eov_uri(uri.strip())
    if uri in url_map:
        return url_map[uri]
    for candidate in url_prefix_order:
        if uri.startswith(candidate.rstrip("/") + "/") or uri.startswith(candidate + "/"):
            return url_map[candidate]
    # Slug fallback: e.g. https://goosocean.org/eov/coral -> top-level code coral
    if "/eov/" in uri:
        slug = uri.split("/eov/", 1)[1].split("/")[0]
        for entry in vocab.get("top_level_eovs", []):
            if entry.get("code") == slug:
                code = entry["code"]
                return (code, code)
    return (None, None)


def canonicalize_eov_uri(uri: str) -> str:
    """Return the canonical EOV URI for any known URI (canonical or alternative)."""
    if not uri:
        return uri
    u = normalize_eov_uri(uri.strip())
    return canonical_uri_map.get(u, u)


def project_eov_keywords_and_codes(eovs):
    """From project EOVs (list of {uri, label, code}), compute eov_keywords (top-level codes) and eov_codes (all codes for filtering)."""
    keywords = set()
    codes = set()
    for e in eovs or []:
        uri = e.get("uri") or ""
        top_code, eov_code = resolve_eov_uri(uri)
        if top_code:
            keywords.add(top_code)
        if eov_code:
            codes.add(eov_code)
        if top_code and top_code != eov_code:
            codes.add(top_code)
    return sorted(keywords), sorted(codes)


def get_schema(node: dict, term: str):
    """
    Resolve a JSON-LD property assuming the default context is schema:
    - Prefer explicit 'schema:term' if present
    - Fall back to bare 'term' otherwise
    """
    schema_key = f"schema:{term}"
    if schema_key in node:
        return node.get(schema_key)
    return node.get(term)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _shift_geom_longitude(geom, to_360: bool):
    """Shift longitudes between [-180,180] and [0,360] domains."""
    if to_360:
        return transform(lambda x, y, z=None: (x + 360 if x < 0 else x, y), geom)
    return transform(lambda x, y, z=None: (x - 360 if x > 180 else x, y), geom)


def _canonicalize_lon(lon: float) -> float:
    """Map longitude to [-180, 180], keeping 180 instead of -180 for boundary values."""
    v = ((float(lon) + 180.0) % 360.0) - 180.0
    if v == -180.0 and lon > 0:
        return 180.0
    return v


def canonicalize_polygonal_longitudes(geom):
    """
    Canonicalize polygonal geometry longitudes to [-180, 180].
    Returns (geometry, changed).
    """
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        return geom, False
    changed = False

    def clean_ring(ring):
        nonlocal changed
        out = []
        for c in ring:
            lon = _canonicalize_lon(c[0])
            if lon != c[0]:
                changed = True
            if len(c) > 2:
                out.append((lon, c[1], c[2]))
            else:
                out.append((lon, c[1]))
        return out

    if geom.geom_type == "Polygon":
        ext = clean_ring(list(geom.exterior.coords))
        holes = [clean_ring(list(i.coords)) for i in geom.interiors]
        return Polygon(ext, holes), changed

    polys = []
    for p in geom.geoms:
        ext = clean_ring(list(p.exterior.coords))
        holes = [clean_ring(list(i.coords)) for i in p.interiors]
        polys.append(Polygon(ext, holes))
    return MultiPolygon(polys), changed


def _ring_crosses_antimeridian(coords) -> bool:
    """Return True if any consecutive lon jump indicates dateline crossing."""
    if not coords:
        return False
    for i in range(1, len(coords)):
        prev_lon = float(coords[i - 1][0])
        lon = float(coords[i][0])
        if abs(lon - prev_lon) > 180:
            return True
    return False


def geometry_crosses_antimeridian(geom) -> bool:
    """Detect whether polygonal geometry truly crosses the dateline."""
    if geom.geom_type == "Polygon":
        if _ring_crosses_antimeridian(list(geom.exterior.coords)):
            return True
        for interior in geom.interiors:
            if _ring_crosses_antimeridian(list(interior.coords)):
                return True
        return False
    if geom.geom_type == "MultiPolygon":
        return any(geometry_crosses_antimeridian(p) for p in geom.geoms)
    return False


def geometry_has_out_of_range_longitudes(geom) -> bool:
    """True when polygonal geometry has lon outside [-180, 180]."""
    if geom.geom_type == "Polygon":
        for c in list(geom.exterior.coords):
            if c[0] < -180 or c[0] > 180:
                return True
        for interior in geom.interiors:
            for c in list(interior.coords):
                if c[0] < -180 or c[0] > 180:
                    return True
        return False
    if geom.geom_type == "MultiPolygon":
        return any(geometry_has_out_of_range_longitudes(p) for p in geom.geoms)
    return False


def geometry_needs_antimeridian_split(geom) -> bool:
    return geometry_crosses_antimeridian(geom) or geometry_has_out_of_range_longitudes(geom)


def split_antimeridian_polygonal(geom):
    """
    Split Polygon/MultiPolygon geometries at the antimeridian and wrap longitudes
    back to [-180, 180]. Returns (geometry, changed).
    """
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        return geom, False
    if not geometry_needs_antimeridian_split(geom):
        return geom, False

    try:
        shifted = _shift_geom_longitude(geom, to_360=True)
        parts = split_geom(shifted, LineString([(180, -90), (180, 90)]))
        polygonal_parts = []
        for g in parts.geoms:
            if g.geom_type == "Polygon":
                polygonal_parts.append(g)
            elif g.geom_type == "MultiPolygon":
                polygonal_parts.extend(list(g.geoms))

        if not polygonal_parts:
            return geom, False

        wrapped = [_shift_geom_longitude(p, to_360=False) for p in polygonal_parts]
        merged = unary_union(wrapped)
        return merged, True
    except Exception:
        return geom, False


def _dedupe_consecutive_coords(coords):
    """Remove consecutive duplicate vertices from a ring coordinate sequence."""
    deduped = []
    prev = None
    for c in coords:
        t = tuple(c)
        if prev is None or t != prev:
            deduped.append(t)
            prev = t
    if deduped and deduped[0] != deduped[-1]:
        deduped.append(deduped[0])
    return deduped


def remove_duplicate_polygon_vertices(geom):
    """
    Remove consecutive duplicate vertices from Polygon/MultiPolygon rings.
    Returns (geometry, changed).
    """
    changed = False

    def clean_polygon(poly: Polygon):
        nonlocal changed
        ext = _dedupe_consecutive_coords(list(poly.exterior.coords))
        holes = []
        for interior in poly.interiors:
            ring = _dedupe_consecutive_coords(list(interior.coords))
            if len(ring) >= 4:
                holes.append(ring)
            else:
                changed = True
        if len(ext) < 4:
            changed = True
            return None
        if ext != list(poly.exterior.coords):
            changed = True
        try:
            return Polygon(ext, holes)
        except Exception:
            changed = True
            return None

    if geom.geom_type == "Polygon":
        p = clean_polygon(geom)
        return (p if p is not None else geom), changed
    if geom.geom_type == "MultiPolygon":
        polys = []
        for p in geom.geoms:
            cp = clean_polygon(p)
            if cp is not None and not cp.is_empty:
                polys.append(cp)
        if not polys:
            return geom, changed
        return MultiPolygon(polys), changed
    return geom, False


def _antimeridian_fix_geojson_kwargs(geom) -> dict:
    """
    antimeridian.fix_geojson assumes typical parcels. Circumpolar polygons that
    cross the dateline and enclose a pole need force_north_pole /
    force_south_pole, or the default fix can invert the region.

    Only apply those flags when the geometry actually needs antimeridian handling
    (dateline crossing or lon outside [-180, 180]). High-latitude *local* boxes
    (e.g. Svalbard-sized rectangles) never cross the dateline; forcing the north
    pole incorrectly turns them into near-global polygons.
    """
    if not geometry_needs_antimeridian_split(geom):
        return {}
    _minx, miny, _maxx, maxy = geom.bounds
    if maxy >= 75.0:
        return {"force_north_pole": True, "fix_winding": False}
    if miny <= -75.0:
        return {"force_south_pole": True, "fix_winding": False}
    return {}


def _geometry_collection_polygonal_only(geom):
    """
    make_valid / antimeridian can yield GeometryCollection with polygonal area plus
    MultiPoint or line debris. Drop non-surfaces so ES and the map see MultiPolygon.
    """
    if geom.geom_type != "GeometryCollection":
        return geom, False
    polys = []
    stack = list(geom.geoms)
    while stack:
        g = stack.pop()
        if g.geom_type == "Polygon":
            polys.append(g)
        elif g.geom_type == "MultiPolygon":
            polys.extend(g.geoms)
        elif g.geom_type == "GeometryCollection":
            stack.extend(g.geoms)
    if not polys:
        return geom, False
    merged = unary_union(polys)
    if merged.is_empty:
        return geom, False
    if merged.geom_type == "GeometryCollection":
        flat = []
        for p in merged.geoms:
            if p.geom_type == "Polygon":
                flat.append(p)
            elif p.geom_type == "MultiPolygon":
                flat.extend(p.geoms)
        if not flat:
            return geom, False
        merged = MultiPolygon(flat)
    elif merged.geom_type == "Polygon":
        merged = MultiPolygon([merged])
    return merged, True


def normalize_geometry_for_indexing(geom):
    """
    Normalize geometry for ES geo_shape indexing:
    - split polygonal geometries across antimeridian
    - run make_valid if geometry is invalid
    Returns (geometry, changed, notes)
    """
    notes = []
    changed = False

    if geom.geom_type in ("Polygon", "MultiPolygon"):
        if antimeridian is not None and geometry_needs_antimeridian_split(geom):
            try:
                original_wkb = geom.wkb
                am_kwargs = _antimeridian_fix_geojson_kwargs(geom)
                fixed_geojson = antimeridian.fix_geojson(
                    copy.deepcopy(mapping(geom)),
                    **am_kwargs,
                )
                geom = shape(fixed_geojson)
                if geom.wkb != original_wkb:
                    changed = True
                    notes.append("antimeridian_fix_geojson")
                if am_kwargs.get("force_north_pole"):
                    notes.append("antimeridian_force_north_pole")
                elif am_kwargs.get("force_south_pole"):
                    notes.append("antimeridian_force_south_pole")
            except Exception:
                # Fall back to internal normalization below.
                pass
        else:
            geom2, did_canonicalize = canonicalize_polygonal_longitudes(geom)
            if did_canonicalize:
                geom = geom2
                changed = True
                notes.append("canonicalized_longitudes")

            geom2, did_split = split_antimeridian_polygonal(geom)
            if did_split:
                geom = geom2
                changed = True
                notes.append("split_antimeridian")

    geom2, did_dedupe = remove_duplicate_polygon_vertices(geom)
    if did_dedupe:
        geom = geom2
        changed = True
        notes.append("dedupe_vertices")

    if not geom.is_valid:
        try:
            geom_valid = make_valid(geom)
            geom = geom_valid
            changed = True
            notes.append("make_valid")
        except Exception:
            pass

    geom2, did_gc_poly = _geometry_collection_polygonal_only(geom)
    if did_gc_poly:
        geom = geom2
        changed = True
        notes.append("geometry_collection_polygonal_only")

    # Keep polygonal outputs as MultiPolygon for consistency where possible.
    if geom.geom_type == "Polygon":
        geom = MultiPolygon([geom])
        changed = True
        notes.append("polygon_to_multipolygon")

    return geom, changed, notes


def extract_wkt_value(as_wkt) -> str | None:
    """Normalize geosparql:asWKT from string or {@value} object."""
    if isinstance(as_wkt, str):
        raw = as_wkt.strip()
    elif isinstance(as_wkt, dict):
        raw = str(as_wkt.get("@value") or "").strip()
    else:
        return None
    if not raw:
        return None
    if raw.startswith("<") and ">" in raw:
        raw = raw.split(">", 1)[1].strip()
    return raw


def extract_wkt(node: dict) -> str | None:
    """
    Extract WKT geometry from either:
    - geosparql:hasGeometry/geosparql:asWKT
    - areaServed[*].schema:geo.geosparql:asWKT (or bare geo)
    - areaServed[*].geosparql:hasGeometry/geosparql:asWKT (EOV metadata app export)
    """
    geom = node.get("geosparql:hasGeometry")
    if isinstance(geom, dict):
        wkt_val = extract_wkt_value(geom.get("geosparql:asWKT"))
        if wkt_val:
            return wkt_val

    area_served = get_schema(node, "areaServed")
    for place in as_list(area_served):
        if not isinstance(place, dict):
            continue
        geo = place.get("geo") or place.get("schema:geo")
        if isinstance(geo, dict):
            wkt_val = extract_wkt_value(geo.get("geosparql:asWKT"))
            if wkt_val:
                return wkt_val
        place_geom = place.get("geosparql:hasGeometry")
        if isinstance(place_geom, dict):
            wkt_val = extract_wkt_value(place_geom.get("geosparql:asWKT"))
            if wkt_val:
                return wkt_val

    return None


def build_eov_by_id(eov_bindings):
    eov_by_id = {}
    for row in eov_bindings:
        project_id = row["id"]["value"].strip()
        raw_uri = row["eovUri"]["value"].strip()
        uri = canonicalize_eov_uri(raw_uri)
        label = row.get("eovLabel", {}).get("value", "")

        # Prefer vocabulary-derived code; fall back to slug if unknown
        top_code, eov_code = resolve_eov_uri(uri)
        if eov_code:
            code = eov_code
        elif "/eov/" in uri:
            code = uri.split("/eov/", 1)[1]
        else:
            code = uri.rsplit("/", 1)[-1]

        if project_id not in eov_by_id:
            eov_by_id[project_id] = []
        if not any(e["uri"] == uri for e in eov_by_id[project_id]):
            eov_by_id[project_id].append({"uri": uri, "label": label, "code": code})
    logging.info("EOV lookup: %d projects with at least one EOV", len(eov_by_id))
    return eov_by_id


def grid_doc_id(project_id: str, cell: str) -> str:
    """Stable Elasticsearch _id for a project geohash grid cell."""
    return f"{project_id}_{cell}"


def delete_grid_docs_for_project(client, project_id: str) -> int:
    """Remove all grid cells for a project. Returns deleted document count."""
    try:
        resp = client.delete_by_query(
            index=grid_index,
            query={"term": {"id": project_id}},
            refresh=False,
            conflicts="proceed",
        )
        return int(resp.get("deleted") or 0)
    except NotFoundError:
        return 0


def _list_indexed_project_ids(client) -> set[str]:
    """Return all document _ids in the project index."""
    ids: set[str] = set()
    try:
        resp = client.search(
            index=project_index,
            query={"match_all": {}},
            _source=False,
            size=10000,
            stored_fields=[],
        )
    except NotFoundError:
        return ids
    for hit in resp["hits"]["hits"]:
        ids.add(hit["_id"])
    total = resp["hits"]["total"]["value"]
    if total > len(ids):
        logging.warning(
            "Project index has %d documents but only %d were scanned for stale prune; "
            "increase scroll/search size if needed.",
            total,
            len(ids),
        )
    return ids


def prune_stale_projects(client, active_project_ids: set[str]) -> dict:
    """
    Remove project and grid documents whose ids are not in the current load set.
    Safe to call after a full export ingest without clearing indices first.
    """
    stats = {"projects_removed": 0, "grid_docs_removed": 0}
    if not active_project_ids:
        log_colored("WARN", "PRUNE", "skipped stale prune: no successfully indexed project ids")
        return stats

    stale_ids = _list_indexed_project_ids(client) - active_project_ids
    if not stale_ids:
        log_colored("OK", "PRUNE", "no stale projects to remove")
        return stats

    for project_id in sorted(stale_ids):
        try:
            client.delete(index=project_index, id=project_id)
            stats["projects_removed"] += 1
        except NotFoundError:
            pass

    try:
        resp = client.delete_by_query(
            index=grid_index,
            query={"terms": {"id": list(stale_ids)}},
            refresh=False,
            conflicts="proceed",
        )
        stats["grid_docs_removed"] = int(resp.get("deleted") or 0)
    except NotFoundError:
        pass

    log_colored(
        "OK",
        "PRUNE",
        f"removed {stats['projects_removed']} stale project(s) and "
        f"{stats['grid_docs_removed']} stale grid cell(s)",
    )
    return stats


def index_project_bindings(
    client,
    results_bindings,
    eov_by_id,
    source_file_by_id,
    *,
    print_indexed_json: bool = False,
    issue_logger: "ImportIssueLogger | None" = None,
    prune_stale: bool = True,
) -> dict:
    results = {"results": {"bindings": results_bindings}}
    stats = {
        "projects_total": len(results["results"]["bindings"]),
        "projects_indexed": 0,
        "projects_not_indexed": 0,
        "grid_docs_indexed": 0,
        "grid_docs_removed": 0,
        "grid_index_errors": 0,
        "projects_removed": 0,
        "temporal_coverage_removed": 0,
        "geometry_normalized": 0,
        "not_indexed_files": set(),
    }
    active_project_ids: set[str] = set()
    for i, result in enumerate(results["results"]["bindings"]):
        project = {k: v["value"] for k, v in result.items()}

        # Stable UUID based on the project URI
        original_uri = project["id"].strip()
        project["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, original_uri))
        project["uri"] = original_uri

        # Temporal coverage and derived year fields.
        # 1) Prefer foundingDate / dissolutionDate when present.
        founding = project.get("founding_date")
        dissolution = project.get("dissolution_date")
        if founding:
            try:
                fd = datetime.fromisoformat(founding.replace("Z", "").strip())
                project["start_date"] = fd.date().isoformat()
                project["start_year"] = fd.year
            except (ValueError, TypeError) as e:
                logging.warning(f"Could not parse founding_date '{founding}' for project {project.get('name', '')}: {e}")
        if dissolution:
            try:
                dd = datetime.fromisoformat(dissolution.replace("Z", "").strip())
                project["end_date"] = dd.date().isoformat()
                project["end_year"] = dd.year
            except (ValueError, TypeError) as e:
                logging.warning(f"Could not parse dissolution_date '{dissolution}' for project {project.get('name', '')}: {e}")

        # 2) Fallback to temporalCoverage only where bounds are still missing.
        temporal = project.get("temporal_coverage")
        if temporal and ("start_year" not in project or "end_year" not in project):
            try:
                s = temporal.replace("Z", "").strip()
                if "/" in s:
                    start_str, end_str = s.split("/", 1)
                    start_dt = datetime.fromisoformat(start_str.strip())
                    end_dt = datetime.fromisoformat(end_str.strip())
                    project.setdefault("start_date", start_dt.date().isoformat())
                    project.setdefault("end_date", end_dt.date().isoformat())
                    project.setdefault("start_year", start_dt.year)
                    project.setdefault("end_year", end_dt.year)
                else:
                    dt = datetime.fromisoformat(s)
                    project.setdefault("start_date", dt.date().isoformat())
                    project.setdefault("end_date", None)
                    project.setdefault("start_year", dt.year)
                    project.setdefault("end_year", dt.year)
            except (ValueError, TypeError) as e:
                logging.warning(f"Could not parse temporal_coverage '{temporal}' for project {project.get('name', '')}: {e}")

        # Elasticsearch mapping expects a single date for temporal_coverage.
        # Drop interval values (e.g. start/end) or malformed values to avoid
        # rejecting the whole project document.
        if "temporal_coverage" in project:
            temporal_value = str(project.get("temporal_coverage") or "").strip()
            if "/" in temporal_value:
                log_colored(
                    "WARN",
                    "REMOVED",
                    f"temporal_coverage interval removed for project '{project.get('name', '')}' ({project.get('id', '')})",
                )
                stats["temporal_coverage_removed"] += 1
                del project["temporal_coverage"]
            elif temporal_value:
                try:
                    datetime.fromisoformat(temporal_value.replace("Z", "").strip())
                except (ValueError, TypeError):
                    log_colored(
                        "WARN",
                        "REMOVED",
                        f"invalid temporal_coverage removed for project '{project.get('name', '')}' ({project.get('id', '')}): {temporal_value}",
                    )
                    stats["temporal_coverage_removed"] += 1
                    del project["temporal_coverage"]
            else:
                log_colored(
                    "WARN",
                    "REMOVED",
                    f"empty temporal_coverage removed for project '{project.get('name', '')}' ({project.get('id', '')})",
                )
                stats["temporal_coverage_removed"] += 1
                del project["temporal_coverage"]

        # Keywords as a list
        if "keywords" in project:
            keywords = [kw.strip() for kw in project["keywords"].split(",") if kw.strip()]
            project["keywords"] = list(dict.fromkeys(keywords))

        # EOVs as combined list of {uri, label, code}; match by normalized URI
        project["eovs"] = eov_by_id.get(original_uri, [])
        project["eov_keywords"], project["eov_codes"] = project_eov_keywords_and_codes(project["eovs"])

        # Funding categories and descriptions (if we ever add them, keep the same shape as before)
        if "funding_categories" in project:
            funding_categories_value = project["funding_categories"]
            if funding_categories_value:
                cats = [c for c in funding_categories_value.split(",") if c]
                project["funding_categories"] = list(dict.fromkeys(cats))
            else:
                # Remove empty string value to avoid mapping conflicts
                del project["funding_categories"]

        if "funding_descriptions" in project:
            funding_descriptions_value = project["funding_descriptions"]
            if funding_descriptions_value:
                descs = [d for d in funding_descriptions_value.split("||") if d]
                project["funding_descriptions"] = descs
            else:
                del project["funding_descriptions"]

        # All additionalProperty name/value pairs
        if "additional_properties" in project:
            additional_props_value = project["additional_properties"]
            if additional_props_value:
                pairs = [p for p in additional_props_value.split("||") if p]
                additional_properties = []
                for pair in pairs:
                    if ":" in pair:
                        name_prop, value_prop = pair.split(":", 1)
                    else:
                        name_prop, value_prop = pair, ""
                    additional_properties.append(
                        {
                            "name": name_prop,
                            "value": value_prop,
                        }
                    )
                project["additional_properties"] = additional_properties
            else:
                # Don't send an empty string for a nested field
                del project["additional_properties"]

        # Contacts: parse JSON string (if present) into nested objects
        if "contacts" in project:
            contacts_value = project["contacts"]
            if contacts_value:
                try:
                    project["contacts"] = json.loads(contacts_value)
                except Exception:
                    del project["contacts"]
            else:
                del project["contacts"]

        # Services: parse JSON string into nested objects
        if "services" in project:
            services_value = project["services"]
            if services_value:
                try:
                    project["services"] = json.loads(services_value)
                except Exception:
                    del project["services"]
            else:
                del project["services"]

        logging.info(f"Loading project {project.get('name', '')} ({i + 1}/{len(results['results']['bindings'])})")

        if print_indexed_json:
            # Pretty-print the project document that will be indexed
            print(json.dumps(project, indent=2, sort_keys=True))

        cells = []
        if "geometry" in project:
            geometry = wkt.loads(project["geometry"])
            geometry, geom_changed, geom_notes = normalize_geometry_for_indexing(geometry)
            if geom_changed:
                stats["geometry_normalized"] += 1
                log_colored(
                    "WARN",
                    "GEOM_NORMALIZED",
                    f"geometry normalized for '{project.get('name', '')}' ({project.get('id', '')}): {', '.join(geom_notes)}",
                )
            geojson = mapping(geometry)
            project["geometry"] = geojson
            buff = buffer(geometry, 0.1)
            if buff.geom_type == "Polygon":
                buff = MultiPolygon([buff])
            for poly in buff.geoms:
                outer_geohashes_polygon = polygon_to_geohashes(poly, 4, False)
                cells.extend(outer_geohashes_polygon)

        indexed_ok = False
        try:
            client.index(index=project_index, id=project["id"], document=project)
            indexed_ok = True
            stats["projects_indexed"] += 1
            active_project_ids.add(project["id"])
            log_colored(
                "OK",
                "INDEXED",
                f"project indexed: '{project.get('name', '')}' ({project.get('id', '')})",
            )
        except BadRequestError as e:
            stats["projects_not_indexed"] += 1
            source_file = source_file_by_id.get(original_uri, "<unknown>")
            stats["not_indexed_files"].add(source_file)
            log_colored(
                "ERROR",
                "NOT_INDEXED",
                f"project failed to index: '{project.get('name', '')}' ({project.get('id', '')}) from {source_file} | reason: {e}",
            )

        if indexed_ok:
            removed = delete_grid_docs_for_project(client, project["id"])
            if removed:
                stats["grid_docs_removed"] += removed

            if cells:
                cells = list(set(cells))
                actions = []
                for cell in cells:
                    lat, lon = geohash.decode(cell)
                    doc = {
                        "id": project["id"],
                        "project": project["name"],
                        "eov_codes": project.get("eov_codes") or [],
                        "eov_keywords": project.get("eov_keywords") or [],
                        "start_year": project.get("start_year"),
                        "end_year": project.get("end_year"),
                        "geometry": (lon, lat),
                    }
                    actions.append(
                        {
                            "_index": grid_index,
                            "_id": grid_doc_id(project["id"], cell),
                            "_source": doc,
                        }
                    )
                try:
                    bulk(client, actions, refresh="false")
                    stats["grid_docs_indexed"] += len(actions)
                    log_colored(
                        "OK",
                        "GRID",
                        f"indexed {len(actions)} grid docs for '{project.get('name', '')}' ({project.get('id', '')})",
                    )
                except BadRequestError as e:
                    stats["grid_index_errors"] += 1
                    log_colored(
                        "ERROR",
                        "GRID_FAILED",
                        f"grid indexing failed for '{project.get('name', '')}' ({project.get('id', '')}) | reason: {e}",
                    )

    if prune_stale:
        prune_stats = prune_stale_projects(client, active_project_ids)
        stats["projects_removed"] = prune_stats["projects_removed"]
        stats["grid_docs_removed"] += prune_stats["grid_docs_removed"]

    return stats


def log_index_summary(stats: dict) -> None:
    log_colored("INFO", "SUMMARY", "----------------------------------------")
    log_colored("INFO", "SUMMARY", f"projects_total: {stats['projects_total']}")
    log_colored("OK", "SUMMARY", f"projects_indexed: {stats['projects_indexed']}")
    if stats["projects_not_indexed"]:
        log_colored("ERROR", "SUMMARY", f"projects_not_indexed: {stats['projects_not_indexed']}")
    else:
        log_colored("OK", "SUMMARY", "projects_not_indexed: 0")
    if stats["temporal_coverage_removed"]:
        log_colored("WARN", "SUMMARY", f"temporal_coverage_removed: {stats['temporal_coverage_removed']}")
    else:
        log_colored("OK", "SUMMARY", "temporal_coverage_removed: 0")
    if stats["geometry_normalized"]:
        log_colored("WARN", "SUMMARY", f"geometry_normalized: {stats['geometry_normalized']}")
    else:
        log_colored("OK", "SUMMARY", "geometry_normalized: 0")
    log_colored("OK", "SUMMARY", f"grid_docs_indexed: {stats['grid_docs_indexed']}")
    if stats.get("grid_docs_removed"):
        log_colored("INFO", "SUMMARY", f"grid_docs_removed: {stats['grid_docs_removed']}")
    if stats.get("projects_removed"):
        log_colored("INFO", "SUMMARY", f"projects_removed: {stats['projects_removed']}")
    if stats["grid_index_errors"]:
        log_colored("ERROR", "SUMMARY", f"grid_index_errors: {stats['grid_index_errors']}")
    else:
        log_colored("OK", "SUMMARY", "grid_index_errors: 0")
    if stats["not_indexed_files"]:
        log_colored("ERROR", "SUMMARY", "files_not_indexed:")
        for file_name in sorted(stats["not_indexed_files"]):
            log_colored("ERROR", "SUMMARY_FILE", f"- {file_name}")
    else:
        log_colored("OK", "SUMMARY", "files_not_indexed: 0")
    log_colored("INFO", "SUMMARY", "----------------------------------------")


class ImportIssueLogger:
    """Collect and emit structured import diagnostics."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = defaultdict(int)
        self._records: list[dict] = []

    def record(self, level: str, code: str, source: str, message: str) -> None:
        self._counts[code] += 1
        self._records.append({"level": level, "code": code, "source": source, "message": message})
        log_colored(level, code, f"{source}: {message}")

    def summary(self) -> None:
        if not self._records:
            log_colored("OK", "IMPORT_ISSUES", "no import issues recorded")
            return
        log_colored("INFO", "IMPORT_ISSUES", "----------------------------------------")
        for code, count in sorted(self._counts.items(), key=lambda x: (-x[1], x[0])):
            level = "ERROR" if code.startswith("ERR") else "WARN" if code.startswith("WARN") else "INFO"
            log_colored(level, "IMPORT_ISSUES", f"{code}: {count}")
        log_colored("INFO", "IMPORT_ISSUES", "----------------------------------------")

    @property
    def records(self):
        return list(self._records)


def create_es_client(es_url: str):
    from elasticsearch import Elasticsearch
    import os

    return Elasticsearch(
        es_url,
        basic_auth=("elastic", os.environ.get("ELASTIC_PASSWORD", "")),
        request_timeout=60,
    )

