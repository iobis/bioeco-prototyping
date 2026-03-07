from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from elasticsearch import Elasticsearch
from elasticsearch.exceptions import NotFoundError

from config import GRID_INDEX
from es_client import get_es_client

router = APIRouter()


def _build_mvt_query(
    eov: Optional[str],
    name: Optional[str],
    start_year: Optional[int],
    end_year: Optional[int],
) -> dict:
    filters = []
    if eov and eov.strip():
        filters.append({"term": {"eov_codes": eov.strip()}})
    if start_year is not None:
        filters.append({"range": {"end_year": {"gte": start_year}}})
    if end_year is not None:
        filters.append({"range": {"start_year": {"lte": end_year}}})
    if name and name.strip():
        filters.append({"term": {"project": name.strip()}})
    if not filters:
        return {"match_all": {}}
    return {"bool": {"filter": filters}}


@router.get("/projects/{z}/{x}/{y}.mvt")
def get_projects_tile(
    z: int,
    x: int,
    y: int,
    eov: Optional[str] = Query(None, description="EOV code to filter"),
    subvariable: Optional[str] = Query(None, description="Subvariable (reserved)"),
    name: Optional[str] = Query(None, description="Filter by project name (keyword match)"),
    start_year: Optional[int] = Query(None),
    end_year: Optional[int] = Query(None),
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

    body = {
        "query": _build_mvt_query(eov, name, start_year, end_year),
        "grid_agg": "geotile",
        "grid_precision": 5,
        "grid_type": "grid",
        "size": 0,
        "aggs": {
            "unique_projects": {
                "cardinality": {
                    "field": "id"  # Ensure this is the correct field name for project IDs
                }
            }
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
