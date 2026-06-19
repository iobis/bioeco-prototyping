"""
Load programme JSON from the EOV metadata app export (nested jsonFiles/*/*.json)
into Elasticsearch.

Schema differences from load_data.py (flat JSON-LD graph export):
  - One subdirectory per programme with a single <programme>.json (plus optional *_actions.json)
  - @type is "Project" (not schema:ResearchProject)
  - EOVs are schema:keywords entries of type schema:DefinedTerm (not schema:variableMeasured)
  - Geometry is schema:areaServed[].schema:geo.geosparql:asWKT (string or {@value} object)
  - Extra @graph nodes (schema:Action, frequency stubs) are ignored for indexing
"""
from __future__ import annotations

import argparse
import json
import logging
import urllib3
from pathlib import Path

from dotenv import load_dotenv

from util import (
    REPO_ROOT,
    DATA_DIR,
    ImportIssueLogger,
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

DEFAULT_INPUT_DIR = DATA_DIR / "eov-metadata-app-front-entries" / "jsonFiles"
PROJECT_TYPE = "Project"
MONETARY_GRANT_TYPES = {"MonetaryGrant", "schema:MonetaryGrant"}


def _keyword_urls(item: dict) -> list[str]:
    """schema:url may be a string or a list of strings in the metadata app export."""
    raw = get_schema(item, "url")
    if isinstance(raw, list):
        return [str(u).strip() for u in raw if str(u).strip()]
    if raw:
        return [str(raw).strip()]
    return []


def _extract_general_keywords(node: dict) -> list[str]:
    """Plain-string schema:keywords entries (e.g. OSPAR, HELCOM) for search/display."""
    terms: list[str] = []
    for item in as_list(get_schema(node, "keywords")):
        if isinstance(item, str) and item.strip():
            terms.append(item.strip())
    return terms


def _extract_contacts(node: dict, source: str, issue_logger: ImportIssueLogger) -> list[dict]:
    contacts: list[dict] = []
    for c in as_list(get_schema(node, "contactPoint")):
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

    parent = get_schema(node, "parentOrganization")
    if isinstance(parent, dict):
        org_name = get_schema(parent, "legalName") or get_schema(parent, "name")
        org_url = get_schema(parent, "url")
        org_email = get_schema(parent, "email")
        if org_name or org_url or org_email:
            contacts.append(
                {
                    "name": str(org_name).strip() if org_name else "",
                    "email": str(org_email).strip() if org_email else "",
                    "url": str(org_url).strip() if org_url else "",
                    "contact_type": "Organization",
                }
            )

    if not contacts:
        issue_logger.record(
            "INFO",
            "INFO_NO_CONTACT",
            source,
            "no schema:contactPoint or parentOrganization contact fields in source JSON",
        )
    return contacts


def load_eov_metadata_graph(source_dir: str, issue_logger: ImportIssueLogger):
    """
    Load Project nodes from jsonFiles/<programme_dir>/<programme>.json.

    Returns (graph_nodes, source_file_by_id) where graph_nodes is a list of Project dicts only.
    """
    path = Path(source_dir).expanduser()
    if not path.exists():
        raise SystemExit(f"Input directory not found at {path}")
    if not path.is_dir():
        raise SystemExit(f"--input must be the jsonFiles directory, got: {path}")

    graph: list[dict] = []
    source_file_by_id: dict[str, str] = {}
    subdirs = sorted(p for p in path.iterdir() if p.is_dir())
    if not subdirs:
        raise SystemExit(f"No programme subdirectories found in {path}")

    files_read = 0
    for subdir in subdirs:
        rel = subdir.name
        json_files = sorted(
            f for f in subdir.glob("*.json") if not f.name.endswith("_actions.json")
        )
        if not json_files:
            issue_logger.record("WARN", "WARN_NO_JSON", rel, "no programme JSON file in folder")
            continue
        if len(json_files) > 1:
            issue_logger.record(
                "WARN",
                "WARN_MULTIPLE_JSON",
                rel,
                f"found {len(json_files)} JSON files; using {json_files[0].name}",
            )
        file_path = json_files[0]
        source_label = f"{rel}/{file_path.name}"

        try:
            with open(file_path, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            issue_logger.record("ERROR", "ERR_INVALID_JSON", source_label, str(e))
            continue
        except OSError as e:
            issue_logger.record("ERROR", "ERR_READ_FILE", source_label, str(e))
            continue

        if not isinstance(data, dict):
            issue_logger.record("ERROR", "ERR_BAD_ROOT", source_label, "root must be a JSON object")
            continue

        nodes = data.get("@graph")
        if not isinstance(nodes, list):
            issue_logger.record("ERROR", "ERR_BAD_GRAPH", source_label, "missing or invalid @graph array")
            continue

        projects = [n for n in nodes if isinstance(n, dict) and n.get("@type") == PROJECT_TYPE]
        if not projects:
            issue_logger.record("ERROR", "ERR_NO_PROJECT", source_label, f'no @type "{PROJECT_TYPE}" node in @graph')
            continue
        if len(projects) > 1:
            issue_logger.record(
                "WARN",
                "WARN_MULTI_PROJECT",
                source_label,
                f"multiple Project nodes ({len(projects)}); using the first",
            )

        extra_nodes = sum(
            1
            for n in nodes
            if isinstance(n, dict) and n.get("@type") not in (PROJECT_TYPE, None) and n not in projects
        )
        if extra_nodes:
            issue_logger.record(
                "INFO",
                "INFO_EXTRA_GRAPH",
                source_label,
                f"{extra_nodes} non-Project @graph node(s) ignored (e.g. Action metadata)",
            )

        node = projects[0]
        proj_id = str(node.get("@id") or "").strip()
        if not proj_id:
            issue_logger.record("ERROR", "ERR_MISSING_ID", source_label, "Project node has no @id")
            continue

        name = get_schema(node, "name") or get_schema(node, "legalName")
        if not str(name or "").strip():
            issue_logger.record("WARN", "WARN_NO_NAME", source_label, "Project has no schema:name or schema:legalName")

        graph.append(node)
        source_file_by_id[proj_id] = source_label
        files_read += 1

    if not graph:
        raise SystemExit(f"No valid Project nodes loaded from {path}")

    log_colored("OK", "LOAD", f"loaded {len(graph)} programmes from {files_read} JSON files in {path}")
    return graph, source_file_by_id


def _append_keyword_eovs(node: dict, proj_id: str, eov_bindings: list, issue_logger: ImportIssueLogger, source: str):
    """EOV metadata app stores EOVs as schema:keywords DefinedTerm objects (and plain strings)."""
    keywords = as_list(get_schema(node, "keywords"))
    defined_terms = [k for k in keywords if isinstance(k, dict)]
    if not defined_terms:
        issue_logger.record(
            "WARN",
            "WARN_NO_EOV",
            source,
            "no DefinedTerm schema:keywords with URLs (only regional/tags or empty)",
        )
        return

    seen_uris: set[str] = set()
    for item in defined_terms:
        item_type = item.get("@type") or ""
        if item_type and item_type not in ("schema:DefinedTerm", "DefinedTerm"):
            issue_logger.record(
                "WARN",
                "WARN_KEYWORD_TYPE",
                source,
                f"unexpected keyword @type '{item_type}' (expected DefinedTerm)",
            )
        label = str(get_schema(item, "name") or "").strip()
        urls = _keyword_urls(item)
        if not urls:
            issue_logger.record("WARN", "WARN_KEYWORD_NO_URI", source, f"keyword without URL: {label or item}")
            continue

        # Prefer GOOS EOV URLs when multiple identifiers are listed (e.g. NERC + GOOS document).
        urls_sorted = sorted(
            urls,
            key=lambda u: (0 if "goosocean.org/eov" in u else 1 if "goosocean.org/document" in u else 2),
        )
        resolved_uri = None
        for uri in urls_sorted:
            top_code, eov_code = resolve_eov_uri(uri)
            if top_code or eov_code:
                resolved_uri = uri
                break

        if not resolved_uri:
            issue_logger.record(
                "WARN",
                "WARN_UNKNOWN_EOV_URI",
                source,
                f"no BioEco EOV vocabulary match for keyword URLs: {urls} ({label})",
            )
            continue

        if resolved_uri in seen_uris:
            continue
        seen_uris.add(resolved_uri)
        eov_bindings.append(
            {
                "id": {"value": proj_id},
                "eovUri": {"value": resolved_uri},
                "eovLabel": {"value": label},
            }
        )


def build_bindings_from_eov_app_graph(
    graph: list[dict],
    source_file_by_id: dict[str, str],
    issue_logger: ImportIssueLogger,
):
    """Build SPARQL-style bindings from EOV metadata app Project nodes."""
    results_bindings = []
    eov_bindings = []

    for node in graph:
        proj_id = str(node.get("@id") or "").strip()
        if not proj_id:
            continue
        source = source_file_by_id.get(proj_id, proj_id)

        b = {"id": {"value": proj_id}}

        name = get_schema(node, "name") or get_schema(node, "legalName")
        if name:
            b["name"] = {"value": str(name).strip()}

        desc = get_schema(node, "description")
        if desc:
            b["description"] = {"value": str(desc).strip()}

        url = get_schema(node, "url")
        if url and str(url).strip():
            b["url"] = {"value": str(url).strip()}

        founding = get_schema(node, "foundingDate")
        if founding and str(founding).strip():
            b["founding_date"] = {"value": str(founding).strip()}

        dissolution = get_schema(node, "dissolutionDate")
        if dissolution and str(dissolution).strip():
            b["dissolution_date"] = {"value": str(dissolution).strip()}

        temporal = get_schema(node, "temporalCoverage")
        if temporal and str(temporal).strip():
            b["temporal_coverage"] = {"value": str(temporal).strip()}

        publishing = as_list(get_schema(node, "publishingPrinciples"))
        pub_urls = [str(p).strip() for p in publishing if str(p).strip()]
        if pub_urls:
            b["publishing_principles"] = {"value": pub_urls[0] if len(pub_urls) == 1 else "||".join(pub_urls)}

        general_keywords = _extract_general_keywords(node)
        if general_keywords:
            b["keywords"] = {"value": ",".join(general_keywords)}

        _append_keyword_eovs(node, proj_id, eov_bindings, issue_logger, source)

        wkt_val = extract_wkt(node)
        if wkt_val:
            b["geometry"] = {"value": wkt_val}
        else:
            issue_logger.record("WARN", "WARN_NO_GEOM", source, "no areaServed geometry / WKT on programme")

        funding_entries = as_list(get_schema(node, "funding"))
        funding_names: list[str] = []
        for f in funding_entries:
            if not isinstance(f, dict):
                continue
            if f.get("@type") not in MONETARY_GRANT_TYPES:
                continue
            grant_name = get_schema(f, "name") or get_schema(f, "description")
            if grant_name and str(grant_name).strip():
                funding_names.append(str(grant_name).strip())
        if funding_names:
            b["funding_descriptions"] = {"value": "||".join(funding_names)}

        contacts = _extract_contacts(node, source, issue_logger)
        if contacts:
            b["contacts"] = {"value": json.dumps(contacts)}

        services: list[dict] = []
        offers = as_list(get_schema(node, "makesOffer"))
        for off in offers:
            if not isinstance(off, dict):
                continue
            offer_name = get_schema(off, "name")
            item = get_schema(off, "itemOffered")
            if not isinstance(item, dict):
                continue
            item_url = get_schema(item, "url")
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

        results_bindings.append(b)

    logging.info(
        "Prepared %d project bindings and %d EOV bindings from EOV metadata app JSON",
        len(results_bindings),
        len(eov_bindings),
    )
    return results_bindings, eov_bindings


def main(
    input_source: str | None,
    clear_indexes: bool = False,
    print_indexed_json: bool = False,
    es_url: str = "",
    prune_stale: bool = True,
):
    load_dotenv(REPO_ROOT / ".env", override=False)
    issue_logger = ImportIssueLogger()

    if not es_url:
        raise SystemExit("You must provide an Elasticsearch endpoint via --es-url.")

    input_dir = input_source or str(DEFAULT_INPUT_DIR)
    client = create_es_client(es_url)
    ensure_indices(client, clear_indexes=clear_indexes)

    graph, source_file_by_id = load_eov_metadata_graph(input_dir, issue_logger)
    results_bindings, eov_bindings = build_bindings_from_eov_app_graph(
        graph, source_file_by_id, issue_logger
    )
    eov_by_id = build_eov_by_id(eov_bindings)
    stats = index_project_bindings(
        client,
        results_bindings,
        eov_by_id,
        source_file_by_id,
        print_indexed_json=print_indexed_json,
        issue_logger=issue_logger,
        prune_stale=prune_stale,
    )
    log_index_summary(stats)
    issue_logger.summary()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Load EOV metadata app programme JSON (jsonFiles/*/*.json) into Elasticsearch.",
    )
    parser.add_argument(
        "--input",
        dest="input_source",
        default=None,
        help=f"Path to jsonFiles directory (default: {DEFAULT_INPUT_DIR})",
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
        help="Delete and recreate the project and project_grid indices before loading.",
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
