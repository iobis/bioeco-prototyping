from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from elasticsearch import Elasticsearch
from elasticsearch.exceptions import NotFoundError

from config import PROJECT_INDEX
from es_client import get_es_client

router = APIRouter()


def _build_projects_query(
    eov: Optional[str] = None,
    name: Optional[str] = None,
    start_year: Optional[int] = None,
    end_year: Optional[int] = None,
    bbox: Optional[str] = None,
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

    if eov and eov.strip():
        code_or_uri = eov.strip()
        filters.append({
            "nested": {
                "path": "eovs",
                "query": {
                    "bool": {
                        "should": [
                            {"term": {"eovs.code": code_or_uri}},
                            {"term": {"eovs.uri": code_or_uri}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            }
        })

    if start_year is not None:
        filters.append({"range": {"end_year": {"gte": start_year}}})
    if end_year is not None:
        filters.append({"range": {"start_year": {"lte": end_year}}})

    if bbox and bbox.strip():
        try:
            parts = [p.strip() for p in bbox.split(",")]
            if len(parts) != 4:
                raise ValueError("bbox must be min_lon,min_lat,max_lon,max_lat")
            min_lon, min_lat, max_lon, max_lat = map(float, parts)
            filters.append({
                "geo_bounding_box": {
                    "geometry": {
                        "top_left": {"lat": max_lat, "lon": min_lon},
                        "bottom_right": {"lat": min_lat, "lon": max_lon},
                    }
                }
            })
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid bbox: {e}")

    body = {"query": {"bool": {}}}
    if must:
        body["query"]["bool"]["must"] = must
    if filters:
        body["query"]["bool"]["filter"] = filters
    if not must and not filters:
        body["query"] = {"match_all": {}}
    return body


@router.get("")
def list_projects(
    eov: Optional[str] = Query(None, description="EOV code or URI"),
    subvariable: Optional[str] = Query(None, description="Subvariable (reserved for future use)"),
    name: Optional[str] = Query(None, description="Free-text search on name and description"),
    start_year: Optional[int] = Query(None, description="Filter projects active on or after this year"),
    end_year: Optional[int] = Query(None, description="Filter projects active on or before this year"),
    bbox: Optional[str] = Query(None, description="Bounding box: min_lon,min_lat,max_lon,max_lat"),
    from_: int = Query(0, alias="from", ge=0),
    size: int = Query(20, ge=1, le=100),
    es: Elasticsearch = Depends(get_es_client),
):
    """List and search projects with optional filters."""
    query_body = _build_projects_query(
        eov=eov,
        name=name,
        start_year=start_year,
        end_year=end_year,
        bbox=bbox,
    )
    body = {
        **query_body,
        "from": from_,
        "size": size,
        "sort": [{"name.keyword": "asc"}],
    }
    try:
        resp = es.search(index=PROJECT_INDEX, body=body)
    except NotFoundError:
        return {"total": 0, "items": []}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    total = resp["hits"]["total"]["value"]
    items = [h["_source"] for h in resp["hits"]["hits"]]
    return {"total": total, "items": items}


@router.get("/{project_id}")
def get_project(
    project_id: str,
    es: Elasticsearch = Depends(get_es_client),
):
    """Fetch a single project by ID (UUID)."""
    try:
        resp = es.get(index=PROJECT_INDEX, id=project_id)
    except NotFoundError:
        raise HTTPException(status_code=404, detail="Project not found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
    return resp["_source"]
