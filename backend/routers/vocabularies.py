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


def _load_eov_vocabulary():
    """Load the single EOV vocabulary file."""
    data = _load_json("eov_vocabulary.json")
    return data


@router.get("/eov_vocabulary")
def get_eov_vocabulary():
    """Return the full EOV vocabulary (top-level EOVs and subvariables with url, code, label)."""
    return _load_eov_vocabulary()


@router.get("/eovs")
def get_eovs():
    """Return the list of top-level EOVs from the vocabulary."""
    data = _load_eov_vocabulary()
    return data.get("top_level_eovs", [])


@router.get("/subvariables")
def get_subvariables():
    """Return the list of subvariables from the vocabulary."""
    data = _load_eov_vocabulary()
    return data.get("subvariables", [])
