from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from elasticsearch import Elasticsearch
from elasticsearch.exceptions import NotFoundError

from config import GRID_INDEX
from es_client import get_es_client
from query_filters import normalize_status, parse_readiness_levels, readiness_filters, status_filters

router = APIRouter()


def _build_mvt_query(
    eov: Optional[str],
    eov_category: Optional[str],
    name: Optional[str],
    start_year: Optional[int],
    end_year: Optional[int],
    status: Optional[str],
    readiness_data: Optional[list[int]] = None,
    readiness_requirements: Optional[list[int]] = None,
    readiness_coordination: Optional[list[int]] = None,
) -> dict:
    filters = []
    if eov and eov.strip():
        filters.append({"term": {"eov_codes": eov.strip()}})
    if eov_category and eov_category.strip():
        categories = [c.strip().lower() for c in eov_category.split(",") if c.strip()]
        if categories:
            filters.append({"terms": {"eov_keywords": categories}})
    if start_year is not None:
        filters.append({"range": {"end_year": {"gte": start_year}}})
    if end_year is not None:
        filters.append({"range": {"start_year": {"lte": end_year}}})
    if name and name.strip():
        filters.append({
            "match": {
                "project": {
                    "query": name.strip(),
                    "fuzziness": "AUTO",
                }
            }
        })
    filters.extend(status_filters(status))
    filters.extend(
        readiness_filters(
            data=readiness_data,
            requirements=readiness_requirements,
            coordination=readiness_coordination,
        )
    )
    if not filters:
        return {"match_all": {}}
    return {"bool": {"filter": filters}}


@router.get("/projects/{z}/{x}/{y}.mvt")
def get_projects_tile(
    z: int,
    x: int,
    y: int,
    eov: Optional[str] = Query(None, description="EOV code to filter"),
    eov_category: Optional[str] = Query(None, description="High-level EOV category (e.g. fish, coral); comma-separated for multiple"),
    subvariable: Optional[str] = Query(None, description="Subvariable (reserved)"),
    name: Optional[str] = Query(None, description="Filter by project name (full-text match, same as list)"),
    start_year: Optional[int] = Query(None),
    end_year: Optional[int] = Query(None),
    status: Optional[str] = Query(
        "all",
        description="Programme activity: active, inactive, or all (relative to the current calendar year)",
    ),
    readiness_data: Optional[str] = Query(
        None,
        description="GOOS readiness-data levels 1–9 (comma-separated)",
    ),
    readiness_requirements: Optional[str] = Query(
        None,
        description="GOOS readiness-requirements levels 1–9 (comma-separated)",
    ),
    readiness_coordination: Optional[str] = Query(
        None,
        description="GOOS readiness-coordination levels 1–9 (comma-separated)",
    ),
    es: Elasticsearch = Depends(get_es_client),
):
    """Return a Mapbox Vector Tile from Elasticsearch's native _mvt API (project_grid)."""
    if z < 0 or z > 29:
        return Response(
            content=b"", media_type="application/vnd.mapbox-vector-tile", status_code=400
        )
    n = 2**z
    if x < 0 or x >= n or y < 0 or y >= n:
        return Response(
            content=b"", media_type="application/vnd.mapbox-vector-tile", status_code=400
        )

    try:
        status_norm = normalize_status(status)
        readiness_data_levels = parse_readiness_levels(readiness_data)
        readiness_requirements_levels = parse_readiness_levels(readiness_requirements)
        readiness_coordination_levels = parse_readiness_levels(readiness_coordination)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    body = {
        "query": _build_mvt_query(
            eov,
            eov_category,
            name,
            start_year,
            end_year,
            status_norm,
            readiness_data_levels,
            readiness_requirements_levels,
            readiness_coordination_levels,
        ),
        "grid_agg": "geotile",
        "grid_precision": 5,
        "grid_type": "grid",
        "size": 0,
        "aggs": {
            "unique_projects": {
                "cardinality": {
                    "field": "id",
                }
            },
            "unique_eovs": {
                "cardinality": {
                    "field": "eov_keywords",
                }
            },
        }
    }
    try:
        resp = es.search_mvt(
            index=GRID_INDEX,
            field="geometry",
            zoom=z,
            x=x,
            y=y,
            body=body,
        )
    except NotFoundError:
        return Response(content=b"", media_type="application/vnd.mapbox-vector-tile")
    except Exception:
        return Response(
            content=b"", media_type="application/vnd.mapbox-vector-tile", status_code=502
        )

    # Elasticsearch returns binary MVT; response body is bytes (BinaryApiResponse.body in 8.x)
    raw = getattr(resp, "body", resp)
    if isinstance(raw, bytes):
        return Response(content=raw, media_type="application/vnd.mapbox-vector-tile")
    # Fallback if client ever returns parsed
    return Response(
        content=b"", media_type="application/vnd.mapbox-vector-tile", status_code=502
    )
