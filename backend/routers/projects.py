from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from elasticsearch import Elasticsearch
from elasticsearch.exceptions import NotFoundError

from config import GRID_INDEX, PROJECT_INDEX
from es_client import get_es_client
from query_filters import normalize_status, status_filters

router = APIRouter()

# Enough unique programmes per map cell for terms aggregation.
_GRID_ID_AGG_SIZE = 10000


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in bbox.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be min_lon,min_lat,max_lon,max_lat")
    min_lon, min_lat, max_lon, max_lat = map(float, parts)
    return min_lon, min_lat, max_lon, max_lat


def _build_projects_query(
    eov: Optional[str] = None,
    eov_category: Optional[str] = None,
    name: Optional[str] = None,
    start_year: Optional[int] = None,
    end_year: Optional[int] = None,
    status: Optional[str] = None,
):
    must = []
    filters = []

    if name and name.strip():
        must.append({
            "multi_match": {
                "query": name.strip(),
                "fields": ["name", "description"],
                "type": "best_fields",
                "fuzziness": "AUTO",
            }
        })

    if eov_category and eov_category.strip():
        categories = [c.strip().lower() for c in eov_category.split(",") if c.strip()]
        if categories:
            filters.append({"terms": {"eov_keywords": categories}})
    elif eov and eov.strip():
        code = eov.strip()
        filters.append({"term": {"eov_codes": code}})

    if start_year is not None:
        filters.append({"range": {"end_year": {"gte": start_year}}})
    if end_year is not None:
        filters.append({"range": {"start_year": {"lte": end_year}}})

    filters.extend(status_filters(status))

    body = {"query": {"bool": {}}}
    if must:
        body["query"]["bool"]["must"] = must
    if filters:
        body["query"]["bool"]["filter"] = filters
    if not must and not filters:
        body["query"] = {"match_all": {}}
    return body


def _build_grid_cell_query(
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    eov: Optional[str] = None,
    eov_category: Optional[str] = None,
    name: Optional[str] = None,
    start_year: Optional[int] = None,
    end_year: Optional[int] = None,
    status: Optional[str] = None,
) -> dict:
    """Filters aligned with map tiles so cell counts match the programme list."""
    filters = [
        {
            "geo_bounding_box": {
                "geometry": {
                    "top_left": {"lat": max_lat, "lon": min_lon},
                    "bottom_right": {"lat": min_lat, "lon": max_lon},
                }
            }
        }
    ]
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
    return {"bool": {"filter": filters}}


def _project_ids_for_cell(
    es: Elasticsearch,
    bbox: str,
    eov: Optional[str] = None,
    eov_category: Optional[str] = None,
    name: Optional[str] = None,
    start_year: Optional[int] = None,
    end_year: Optional[int] = None,
    status: Optional[str] = None,
) -> list[str]:
    min_lon, min_lat, max_lon, max_lat = _parse_bbox(bbox)
    body = {
        "size": 0,
        "query": _build_grid_cell_query(
            min_lon,
            min_lat,
            max_lon,
            max_lat,
            eov=eov,
            eov_category=eov_category,
            name=name,
            start_year=start_year,
            end_year=end_year,
            status=status,
        ),
        "aggs": {
            "ids": {
                "terms": {"field": "id", "size": _GRID_ID_AGG_SIZE},
            }
        },
    }
    resp = es.search(index=GRID_INDEX, body=body)
    return [b["key"] for b in resp["aggregations"]["ids"]["buckets"]]


@router.get("")
def list_projects(
    eov: Optional[str] = Query(None, description="EOV code or URI"),
    eov_category: Optional[str] = Query(None, description="High-level EOV category (e.g. fish, coral); comma-separated for multiple"),
    subvariable: Optional[str] = Query(None, description="Subvariable (reserved for future use)"),
    name: Optional[str] = Query(None, description="Free-text search on name and description"),
    start_year: Optional[int] = Query(None, description="Filter projects active on or after this year"),
    end_year: Optional[int] = Query(None, description="Filter projects active on or before this year"),
    status: Optional[str] = Query(
        "all",
        description="Programme activity: active, inactive, or all (relative to the current calendar year)",
    ),
    bbox: Optional[str] = Query(None, description="Bounding box: min_lon,min_lat,max_lon,max_lat"),
    include_geometry: bool = Query(False, description="Include geometry in each project item"),
    from_: int = Query(0, alias="from", ge=0),
    size: int = Query(20, ge=1, le=100),
    es: Elasticsearch = Depends(get_es_client),
):
    """List and search projects with optional filters.

    When ``bbox`` is set (map cell filter), programme IDs come from ``project_grid``
    so the list matches the map cell count; full documents are then loaded from
    the project index.
    """
    try:
        status_norm = normalize_status(status)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        if bbox and bbox.strip():
            try:
                project_ids = _project_ids_for_cell(
                    es,
                    bbox.strip(),
                    eov=eov,
                    eov_category=eov_category,
                    name=name,
                    start_year=start_year,
                    end_year=end_year,
                    status=status_norm,
                )
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid bbox: {e}") from e
            if not project_ids:
                return {"total": 0, "items": []}
            query_body = {"query": {"ids": {"values": project_ids}}}
        else:
            query_body = _build_projects_query(
                eov=eov,
                eov_category=eov_category,
                name=name,
                start_year=start_year,
                end_year=end_year,
                status=status_norm,
            )

        body = {
            **query_body,
            "from": from_,
            "size": size,
            "sort": [{"name.keyword": "asc"}],
        }
        if not include_geometry:
            body["_source"] = {"excludes": ["geometry"]}
        resp = es.search(index=PROJECT_INDEX, body=body)
    except NotFoundError:
        return {"total": 0, "items": []}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    total = resp["hits"]["total"]["value"]
    items = [h["_source"] for h in resp["hits"]["hits"]]
    return {"total": total, "items": items}


@router.get("/{project_id}")
def get_project(
    project_id: str,
    include_geometry: bool = Query(False, description="Include geometry in the project response"),
    es: Elasticsearch = Depends(get_es_client),
):
    """Fetch a single project by ID (UUID)."""
    try:
        resp = es.get(
            index=PROJECT_INDEX,
            id=project_id,
            _source_excludes=["geometry"] if not include_geometry else None,
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return resp["_source"]
