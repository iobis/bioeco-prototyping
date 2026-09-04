from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from elasticsearch import Elasticsearch
from elasticsearch.exceptions import NotFoundError

from config import IMPORT_RUN_INDEX
from es_client import get_es_client

router = APIRouter()


@router.get("/latest")
def get_latest_import_run(
    include_issues: bool = Query(
        True,
        description="Include the full issues list (set false for a lighter summary)",
    ),
    level: Optional[str] = Query(
        None,
        description="If set, only return issues with this level (ERROR, WARN, INFO)",
    ),
    es: Elasticsearch = Depends(get_es_client),
):
    """Return the most recent metadata indexing run summary and issues."""
    try:
        resp = es.search(
            index=IMPORT_RUN_INDEX,
            body={
                "size": 1,
                "sort": [{"finished_at": {"order": "desc"}}],
                "query": {"match_all": {}},
            },
        )
    except NotFoundError:
        raise HTTPException(status_code=404, detail="No import runs found")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    hits = resp.get("hits", {}).get("hits", [])
    if not hits:
        raise HTTPException(status_code=404, detail="No import runs found")

    doc = hits[0]["_source"]
    issues = doc.get("issues") or []
    if level:
        level_upper = level.strip().upper()
        issues = [i for i in issues if str(i.get("level", "")).upper() == level_upper]

    result = {
        "run_id": doc.get("run_id"),
        "source": doc.get("source"),
        "started_at": doc.get("started_at"),
        "finished_at": doc.get("finished_at"),
        "stats": doc.get("stats") or {},
        "issue_counts": doc.get("issue_counts") or {},
        "issue_total": len(doc.get("issues") or []),
    }
    if include_issues:
        result["issues"] = issues
    return result
