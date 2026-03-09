from elasticsearch import BadRequestError
from elasticsearch.helpers import bulk
from shapely import wkt, buffer, MultiPolygon
from shapely.geometry import mapping
import urllib3
import urllib.request
import logging
from polygon_geohasher.polygon_geohasher import polygon_to_geohashes
import geohash
import uuid
from datetime import datetime
from pathlib import Path
import argparse
import json

from util import create_es_client


project_index = "project"
grid_index = "project_grid"
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(level=logging.INFO)
logging.getLogger("elastic_transport.transport").setLevel(logging.WARNING)

# Path to data dir (repo root / data)
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# Path to exported JSON-LD graph
GRAPH_PATH = Path("/Users/pieter/IPOfI Dropbox/Pieter Provoost/werk/projects/GOOS bioeco/bioeco-export/bioeco_graph.jsonld")


# elastic

client = create_es_client()


def ensure_indices(clear_indexes: bool = False):
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


def resolve_eov_uri(uri: str):
    """Resolve a project EOV URI to (top_level_code, eov_code) or (None, None)."""
    if not uri or not url_map:
        return (None, None)
    uri = uri.strip()
    if uri in url_map:
        return url_map[uri]
    for candidate in url_prefix_order:
        if uri.startswith(candidate.rstrip("/") + "/") or uri.startswith(candidate + "/"):
            return url_map[candidate]
    return (None, None)


def canonicalize_eov_uri(uri: str) -> str:
    """Return the canonical EOV URI for any known URI (canonical or alternative)."""
    if not uri:
        return uri
    u = uri.strip()
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


def extract_wkt(node: dict) -> str | None:
    """
    Extract WKT geometry from either:
    - geosparql:hasGeometry/geosparql:asWKT/@value
    - areaServed[*].geo.geosparql:asWKT/@value
    and strip any leading CRS prefix like "<...> POLYGON(...)"
    """
    # 1) Direct geosparql:hasGeometry
    geom = node.get("geosparql:hasGeometry")
    if isinstance(geom, dict):
        as_wkt = geom.get("geosparql:asWKT")
        if isinstance(as_wkt, dict):
            raw = as_wkt.get("@value")
            if isinstance(raw, str) and raw.strip():
                s = raw.strip()
                if s.startswith("<") and ">" in s:
                    s = s.split(">", 1)[1].strip()
                return s

    # 2) areaServed[*].geo.geosparql:asWKT
    area_served = get_schema(node, "areaServed")
    for place in as_list(area_served):
        if not isinstance(place, dict):
            continue
        geo = place.get("geo")
        if not isinstance(geo, dict):
            continue
        as_wkt = geo.get("geosparql:asWKT")
        if isinstance(as_wkt, dict):
            raw = as_wkt.get("@value")
            if isinstance(raw, str) and raw.strip():
                s = raw.strip()
                if s.startswith("<") and ">" in s:
                    s = s.split(">", 1)[1].strip()
                return s

    return None


def load_graph(source: str):
    # Source can be a local path or a URL. Content can be:
    # - JSON-LD with @graph
    # - A list of project objects
    # - A single project object
    if source.startswith("http://") or source.startswith("https://"):
        logging.info("Loading JSON-LD from URL %s", source)
        with urllib.request.urlopen(source) as resp:
            raw = resp.read()
        data = json.loads(raw.decode("utf-8"))
    else:
        path = Path(source).expanduser()
        if not path.exists():
            raise SystemExit(f"JSON/JSON-LD source not found at {path}")
        logging.info("Loading JSON-LD from file %s", path)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

    if isinstance(data, dict) and "@graph" in data:
        graph = data.get("@graph", [])
    elif isinstance(data, list):
        graph = data
    elif isinstance(data, dict):
        graph = [data]
    else:
        raise SystemExit("Unsupported JSON/JSON-LD structure; expected @graph, list, or single object.")

    logging.info("Loaded JSON-LD graph with %d nodes", len(graph))
    return graph


def main(input_source: str | None, clear_indexes: bool = False, print_indexed_json: bool = False):
    ensure_indices(clear_indexes=clear_indexes)

    source = input_source or str(GRAPH_PATH)
    graph = load_graph(source)

    # Build project list and EOV list similar to previous SPARQL bindings
    results_bindings = []
    eov_bindings = []

    project_types = {"schema:ResearchProject", "ResearchProject", "schema:Project", "Project"}

    for node in graph:
        if node.get("@type") not in project_types:
            continue

        proj_id = node.get("@id")
        if not proj_id:
            continue

        # Core fields
        b = {
            "id": {"value": proj_id},
        }
        # Assume default context is schema:, but accept bare terms too
        name = get_schema(node, "name")
        if name:
            b["name"] = {"value": name}
        desc = get_schema(node, "description")
        if desc:
            b["description"] = {"value": desc}
        temporal = get_schema(node, "temporalCoverage")
        if temporal:
            b["temporal_coverage"] = {"value": temporal}
        # Founding / dissolution dates (used as temporal bounds when present)
        founding = get_schema(node, "foundingDate")
        if founding:
            b["founding_date"] = {"value": founding}
        dissolution = get_schema(node, "dissolutionDate")
        if dissolution:
            b["dissolution_date"] = {"value": dissolution}
        url = get_schema(node, "url")
        if url:
            b["url"] = {"value": url}

        # Keywords (schema:keywords or keywords) – normalise to a comma-separated list of human-readable terms,
        # and also treat any keyword URLs that match the EOV vocabulary as EOVs (but avoid duplicating EOV names
        # in the general keywords list).
        kw = get_schema(node, "keywords")
        if kw:
            kws = as_list(kw)
            keyword_terms: list[str] = []
            for item in kws:
                if isinstance(item, dict):
                    # Prefer a name on the keyword object
                    name_val = get_schema(item, "name")
                    url_val = get_schema(item, "url")

                    # Treat URLs as potential EOV identifiers
                    uris: list[str] = []
                    if isinstance(url_val, list):
                        uris = [str(u).strip() for u in url_val if str(u).strip()]
                    elif url_val:
                        uris = [str(url_val).strip()]

                    is_eov_keyword = False
                    for uri_candidate in uris:
                        if not uri_candidate:
                            continue
                        top_code, eov_code = resolve_eov_uri(uri_candidate)
                        if top_code or eov_code:
                            is_eov_keyword = True
                            # Register this as an EOV binding so it contributes to project['eovs']
                            eov_bindings.append(
                                {
                                    "id": {"value": proj_id},
                                    "eovUri": {"value": uri_candidate},
                                    "eovLabel": {"value": str(name_val) if name_val else ""},
                                }
                            )
                    # Only include non‑EOV keyword names in the general keywords list
                    if name_val and not is_eov_keyword:
                        keyword_terms.append(str(name_val))
                else:
                    # Simple string keyword
                    s = str(item).strip()
                    if s:
                        keyword_terms.append(s)
            # De-duplicate while preserving order
            seen = set()
            deduped = []
            for term in keyword_terms:
                if term not in seen:
                    seen.add(term)
                    deduped.append(term)
            if deduped:
                b["keywords"] = {"value": ",".join(deduped)}

        # Additional properties: extract readiness* and build concatenated string for generic ones
        add_props = as_list(get_schema(node, "additionalProperty"))
        ap_pairs = []
        for ap in add_props:
            if not isinstance(ap, dict):
                continue
            name_ap = str(ap.get("schema:name") or "").strip()
            value_ap = str(ap.get("schema:value") or "").strip()
            if not name_ap:
                continue
            if value_ap:
                ap_pairs.append(f"{name_ap}:{value_ap}")
            # Specific readiness fields
            if name_ap == "readinessData":
                b["readiness_data"] = {"value": value_ap}
            elif name_ap == "readinessRequirements":
                b["readiness_requirements"] = {"value": value_ap}
            elif name_ap == "readinessCoordination":
                b["readiness_coordination"] = {"value": value_ap}
            elif name_ap == "maintenanceFrequency":
                b["maintenance_frequency"] = {"value": value_ap}
        if ap_pairs:
            b["additional_properties"] = {"value": "||".join(ap_pairs)}

        # Funding: handle MonetaryGrant entries; use grant name as a simple description.
        funding_entries = as_list(get_schema(node, "funding"))
        funding_names: list[str] = []
        for f in funding_entries:
            if not isinstance(f, dict):
                continue
            if f.get("@type") != "MonetaryGrant":
                continue
            grant_name = get_schema(f, "name")
            if grant_name:
                funding_names.append(str(grant_name).strip())
        if funding_names:
            # Match the loader's convention: "||"‑separated string, later split into a list.
            b["funding_descriptions"] = {"value": "||".join(funding_names)}

        # Geometry: from geosparql:hasGeometry or areaServed[*].geo.geosparql:asWKT
        wkt_val = extract_wkt(node)
        if wkt_val:
            b["geometry"] = {"value": wkt_val}

        results_bindings.append(b)

        # VariableMeasured → eov_bindings
        vars_measured = as_list(get_schema(node, "variableMeasured"))
        for vm in vars_measured:
            if not isinstance(vm, dict):
                continue
            eov_uri = vm.get("schema:propertyID")
            if not eov_uri:
                continue
            eov_label = vm.get("schema:name") or ""
            eov_bindings.append({
                "id": {"value": proj_id},
                "eovUri": {"value": eov_uri},
                "eovLabel": {"value": eov_label},
            })

    logging.info("Prepared %d project bindings and %d EOV bindings from JSON-LD", len(results_bindings), len(eov_bindings))

    results = {"results": {"bindings": results_bindings}}

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

        logging.info(f"Loading project {project.get('name', '')} ({i + 1}/{len(results['results']['bindings'])})")

        if print_indexed_json:
            # Pretty-print the project document that will be indexed
            print(json.dumps(project, indent=2, sort_keys=True))

        cells = []
        if "geometry" in project:
            geometry = wkt.loads(project["geometry"])
            geojson = mapping(geometry)
            project["geometry"] = geojson
            buff = buffer(geometry, 0.1)
            if buff.geom_type == "Polygon":
                buff = MultiPolygon([buff])
            for poly in buff.geoms:
                outer_geohashes_polygon = polygon_to_geohashes(poly, 4, False)
                cells.extend(outer_geohashes_polygon)

        try:
            client.index(index=project_index, id=project["id"], document=project)
        except BadRequestError as e:
            logging.error(e)

        if cells:
            cells = list(set(cells))
            actions = []
            for cell in list(set(cells)):
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
                action = {
                    "_index": grid_index,
                    "_source": doc,
                }
                actions.append(action)
            try:
                bulk(client, actions, refresh="false")
            except BadRequestError as e:
                logging.error(e)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        dest="input_source",
        help=f"Path or URL to JSON-LD/JSON source; defaults to {GRAPH_PATH}",
    )
    parser.add_argument(
        "--clear-indexes",
        action="store_true",
        help="Delete and recreate the project and project_grid indices before loading data (default: keep existing indices).",
    )
    parser.add_argument(
        "--print-indexed-json",
        action="store_true",
        help="Print each indexed project document as formatted JSON to stdout.",
    )
    args = parser.parse_args()
    main(args.input_source, clear_indexes=args.clear_indexes, print_indexed_json=args.print_indexed_json)

