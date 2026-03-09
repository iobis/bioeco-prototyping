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

from util import create_mapping, create_es_client


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

create_mapping(client, project_index, {
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
})

create_mapping(client, grid_index, {
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
})

# Load EOV vocabulary for resolving URIs to top-level and subvariable codes

def load_eov_vocabulary():
    path = DATA_DIR / "eov_vocabulary.json"
    if not path.exists():
        logging.warning("EOV vocabulary not found at %s; eov_keywords and eov_codes will be empty.", path)
        return {"top_level_eovs": [], "subvariables": []}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_eov_lookups(vocab):
    """Build URI lookups: exact URL -> (top_level_code, eov_code). Subvariable URLs also map to their code; top-level to same code."""
    top_level = vocab.get("top_level_eovs", [])
    subvars = vocab.get("subvariables", [])
    url_map = {}  # uri -> (top_level_code, eov_code)
    # Subvariables first (longer URLs), so we can match .../fish/abundance before .../fish
    for s in subvars:
        code = s.get("code")
        parent = s.get("parent_code")
        if not code or not parent:
            continue
        url = (s.get("url") or "").strip()
        if url:
            url_map[url] = (parent, code)
        for alt in s.get("alt_urls") or []:
            if alt:
                url_map[alt.strip()] = (parent, code)
    for t in top_level:
        code = t.get("code")
        if not code:
            continue
        url = (t.get("url") or "").strip()
        if url and url not in url_map:
            url_map[url] = (code, code)
        for alt in t.get("alt_urls") or []:
            if alt and alt.strip() not in url_map:
                url_map[alt.strip()] = (code, code)
    # Prefix match: sort by URL length descending so longest match wins
    sorted_urls = sorted(url_map.keys(), key=len, reverse=True)
    return url_map, sorted_urls


_vocab = load_eov_vocabulary()
_url_map, _url_prefix_order = build_eov_lookups(_vocab)


def resolve_eov_uri(uri: str):
    """Resolve a project EOV URI to (top_level_code, eov_code) or (None, None)."""
    if not uri or not _url_map:
        return (None, None)
    uri = uri.strip()
    if uri in _url_map:
        return _url_map[uri]
    for candidate in _url_prefix_order:
        if uri.startswith(candidate.rstrip("/") + "/") or uri.startswith(candidate + "/"):
            return _url_map[candidate]
    return (None, None)


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


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


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


def main(input_source: str | None):
    source = input_source or str(GRAPH_PATH)
    graph = load_graph(source)

    # Build project list and EOV list similar to previous SPARQL bindings
    results_bindings = []
    eov_bindings = []

    for node in graph:
        if node.get("@type") != "schema:ResearchProject":
            continue

        proj_id = node.get("@id")
        if not proj_id:
            continue

        # Core fields
        b = {
            "id": {"value": proj_id},
        }
        name = node.get("schema:name")
        if name:
            b["name"] = {"value": name}
        desc = node.get("schema:description")
        if desc:
            b["description"] = {"value": desc}
        temporal = node.get("schema:temporalCoverage")
        if temporal:
            b["temporal_coverage"] = {"value": temporal}
        url = node.get("schema:url")
        if url:
            b["url"] = {"value": url}

        # Keywords (if present as schema:keywords)
        kw = node.get("schema:keywords")
        if kw:
            kws = as_list(kw)
            kw_str = ",".join(str(x) for x in kws if str(x).strip())
            if kw_str:
                b["keywords"] = {"value": kw_str}

        # Additional properties: extract readiness* and build concatenated string for generic ones
        add_props = as_list(node.get("schema:additionalProperty"))
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

        # Funding: if there are categories/descriptions encoded, they would need to be parsed.
        # For now we keep the simple structure used in the graph (MonetaryGrant without extra fields),
        # so funding_categories / funding_descriptions are left empty.

        # Geometry
        geom = node.get("geosparql:hasGeometry")
        if isinstance(geom, dict):
            as_wkt = geom.get("geosparql:asWKT")
            if isinstance(as_wkt, dict):
                wkt_val = as_wkt.get("@value")
                if wkt_val:
                    b["geometry"] = {"value": wkt_val}

        results_bindings.append(b)

        # VariableMeasured → eov_bindings
        vars_measured = as_list(node.get("schema:variableMeasured"))
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
        uri = row["eovUri"]["value"].strip()
        label = row.get("eovLabel", {}).get("value", "")
        if "/eov/" in uri:
            code = uri.split("/eov/", 1)[1]
        else:
            code = uri.rsplit("/", 1)[-1]
        if project_id not in eov_by_id:
            eov_by_id[project_id] = []
        if not any(e["uri"] == uri for e in eov_by_id[project_id]):
            eov_by_id[project_id].append({"uri": uri, "label": label, "code": code})
    logging.info("EOV lookup: %d projects with at least one EOV", len(eov_by_id))

    for i, result in enumerate(results["results"]["bindings"]):
        if limit is not None and i >= limit:
            break
        project = {k: v["value"] for k, v in result.items()}

        # Stable UUID based on the project URI
        original_uri = project["id"].strip()
        project["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, original_uri))
        project["uri"] = original_uri

        # Temporal coverage and derived year fields (single date or ISO 8601 interval start/end)
        temporal = project.get("temporal_coverage")
        if temporal:
            try:
                s = temporal.replace("Z", "").strip()
                if "/" in s:
                    start_str, end_str = s.split("/", 1)
                    start_dt = datetime.fromisoformat(start_str.strip())
                    end_dt = datetime.fromisoformat(end_str.strip())
                    project["start_date"] = start_dt.date().isoformat()
                    project["end_date"] = end_dt.date().isoformat()
                    project["start_year"] = start_dt.year
                    project["end_year"] = end_dt.year
                else:
                    dt = datetime.fromisoformat(s)
                    project["start_date"] = dt.date().isoformat()
                    project["end_date"] = None
                    project["start_year"] = dt.year
                    project["end_year"] = dt.year
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
    args = parser.parse_args()
    main(args.input_source)

