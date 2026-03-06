import json
from pathlib import Path

from fastapi import APIRouter, HTTPException

from config import DATA_DIR

router = APIRouter()


def _load_json(name: str):
    path = DATA_DIR / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Vocabulary file not found: {name}")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to load {name}: {e!s}")


@router.get("/eovs")
def get_eovs():
    """Return the list of EOVs (Essential Ocean Variables) from the data folder."""
    return _load_json("eovs.json")


@router.get("/subvariables")
def get_subvariables():
    """Return the list of subvariables from the data folder."""
    return _load_json("subvariables.json")
