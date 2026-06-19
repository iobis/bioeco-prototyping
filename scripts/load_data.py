"""Load JSON-LD project graph exports (flat *.json per program) into Elasticsearch."""
import argparse
import json
import logging
import urllib3
from pathlib import Path

from dotenv import load_dotenv

from util import (
    REPO_ROOT,
    as_list,
    build_eov_by_id,
    create_es_client,
    ensure_indices,
    extract_wkt,
    get_schema,
    index_project_bindings,
    log_colored,
    log_index_summary,
    resolve_eov_uri,
)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(level=logging.INFO)
logging.getLogger("elastic_transport.transport").setLevel(logging.WARNING)

def load_graph(source_dir: str):
    """
    Load project nodes from a directory containing one JSON file per program.

    Each file may contain:
    - JSON-LD with @graph (preferred; usually a single node)
    - A list of nodes
    - A single node object
    """
    path = Path(source_dir).expanduser()
    if not path.exists():
        raise SystemExit(f"Input directory not found at {path}")
    if not path.is_dir():
        raise SystemExit(f"--input must be a directory containing JSON files, got: {path}")

    files = sorted(path.glob("*.json"))
    if not files:
        raise SystemExit(f"No JSON files found in input directory: {path}")

    graph = []
    source_file_by_id = {}
    for file_path in files:
        try:
            with open(file_path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            logging.warning("Skipping unreadable JSON file %s: %s", file_path, e)
            continue

        if isinstance(data, dict) and "@graph" in data:
            nodes = data.get("@graph", [])
        elif isinstance(data, list):
            nodes = data
        elif isinstance(data, dict):
            nodes = [data]
        else:
            logging.warning("Skipping unsupported JSON structure in %s", file_path)
            continue

        if not isinstance(nodes, list):
            logging.warning("Skipping file with invalid @graph/list payload in %s", file_path)
            continue
        graph.extend(nodes)
        for node in nodes:
            if isinstance(node, dict):
                node_id = str(node.get("@id") or "").strip()
                if node_id and node_id not in source_file_by_id:
                    source_file_by_id[node_id] = file_path.name

    if not graph:
        raise SystemExit(f"No valid project nodes loaded from {path}")

    logging.info("Loaded %d nodes from %d JSON files in %s", len(graph), len(files), path)
    return graph, source_file_by_id

PROJECT_TYPES_JSONLD = {"schema:ResearchProject", "ResearchProject", "schema:Project", "Project"}


def build_bindings_from_jsonld_graph(graph):
    """Build SPARQL-style bindings from a JSON-LD @graph export."""
    results_bindings = []
    eov_bindings = []

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

        # Contacts: handle schema:contactPoint / contactPoint entries.
        contact_entries = as_list(get_schema(node, "contactPoint"))
        contacts: list[dict] = []
        for c in contact_entries:
            if not isinstance(c, dict):
                continue
            name_c = get_schema(c, "name")
            email_c = get_schema(c, "email")
            url_c = get_schema(c, "url")
            type_c = get_schema(c, "contactType")
            if not (name_c or email_c or url_c):
                continue
            contacts.append(
                {
                    "name": str(name_c).strip() if name_c else "",
                    "email": str(email_c).strip() if email_c else "",
                    "url": str(url_c).strip() if url_c else "",
                    "contact_type": str(type_c).strip() if type_c else "",
                }
            )
        if contacts:
            # Store as JSON string in the intermediate binding; converted to objects later.
            b["contacts"] = {"value": json.dumps(contacts)}

        # Services: links to external data products / downloads.
        services: list[dict] = []

        # 1) hasPart DataDownload (or similar) with contentUrl/url
        has_part = get_schema(node, "hasPart")
        for part in as_list(has_part):
            if not isinstance(part, dict):
                continue
            # If a type exists and is not a DataDownload, skip; otherwise be lenient
            part_type = part.get("@type", "") or get_schema(part, "type")
            if part_type and str(part_type) not in ("schema:DataDownload", "DataDownload"):
                # still allow if contentUrl/url present, since user cares about links
                pass
            service_url = get_schema(part, "contentUrl") or get_schema(part, "url")
            service_name = get_schema(part, "name")
            url_str = str(service_url).strip() if service_url else ""
            if not url_str:
                continue
            services.append(
                {
                    "name": str(service_name).strip() if service_name else "",
                    "url": url_str,
                }
            )

        # 2) makesOffer Offers: use Offer name + itemOffered.url
        offers = as_list(get_schema(node, "makesOffer"))
        for off in offers:
            if not isinstance(off, dict):
                continue
            offer_name = get_schema(off, "name")
            item = get_schema(off, "itemOffered")
            if not isinstance(item, dict):
                continue
            item_url = get_schema(item, "url")
            # item_url can be string or list
            url_str = ""
            if isinstance(item_url, list):
                for u in item_url:
                    s = str(u).strip()
                    if s:
                        url_str = s
                        break
            elif item_url:
                url_str = str(item_url).strip()
            if not url_str:
                continue
            services.append(
                {
                    "name": str(offer_name).strip() if offer_name else "",
                    "url": url_str,
                }
            )

        if services:
            b["services"] = {"value": json.dumps(services)}

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


    logging.info(
        "Prepared %d project bindings and %d EOV bindings from JSON-LD",
        len(results_bindings),
        len(eov_bindings),
    )
    return results_bindings, eov_bindings



def main(input_source: str | None, clear_indexes: bool = False, print_indexed_json: bool = False, es_url: str = "", prune_stale: bool = True):
    load_dotenv(REPO_ROOT / ".env", override=False)

    if not es_url:
        raise SystemExit("You must provide an Elasticsearch endpoint via --es-url.")
    client = create_es_client(es_url)
    ensure_indices(client, clear_indexes=clear_indexes)

    if not input_source:
        raise SystemExit("You must provide --input pointing to a directory of per-program JSON files.")

    graph, source_file_by_id = load_graph(input_source)
    results_bindings, eov_bindings = build_bindings_from_jsonld_graph(graph)
    eov_by_id = build_eov_by_id(eov_bindings)
    stats = index_project_bindings(
        client,
        results_bindings,
        eov_by_id,
        source_file_by_id,
        print_indexed_json=print_indexed_json,
        prune_stale=prune_stale,
    )
    log_index_summary(stats)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        dest="input_source",
        help="Path to a folder containing one JSON file per program.",
    )
    parser.add_argument(
        "--es-url",
        dest="es_url",
        required=True,
        help="Elasticsearch endpoint URL (e.g. http://localhost:9200).",
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
    parser.add_argument(
        "--no-prune-stale",
        action="store_true",
        help="Keep project/grid documents that are absent from this load (default: remove them).",
    )
    args = parser.parse_args()
    main(
        args.input_source,
        clear_indexes=args.clear_indexes,
        print_indexed_json=args.print_indexed_json,
        es_url=args.es_url,
        prune_stale=not args.no_prune_stale,
    )

