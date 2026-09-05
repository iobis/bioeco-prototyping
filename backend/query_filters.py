"""Shared Elasticsearch filter helpers for programme queries."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

ProgrammeStatus = Literal["active", "inactive", "all"]


def normalize_status(status: Optional[str]) -> ProgrammeStatus:
    if not status:
        return "all"
    value = status.strip().lower()
    if value in ("active", "inactive", "all"):
        return value  # type: ignore[return-value]
    raise ValueError("status must be one of: active, inactive, all")


def parse_readiness_levels(raw: Optional[str]) -> list[int]:
    """Parse comma-separated readiness level numbers (1–9)."""
    if not raw or not raw.strip():
        return []
    levels: list[int] = []
    seen: set[int] = set()
    for part in raw.split(","):
        token = part.strip()
        if not token:
            continue
        # Accept "5", "L5", or "Level 5 - …"
        digits = "".join(ch for ch in token if ch.isdigit())
        if not digits:
            raise ValueError(f"invalid readiness level: {part!r}")
        level = int(digits)
        if level < 1 or level > 9:
            raise ValueError("readiness levels must be between 1 and 9")
        if level not in seen:
            seen.add(level)
            levels.append(level)
    return levels


def _normalize_level_list(levels: Optional[list[int] | str]) -> list[int]:
    if isinstance(levels, str) or levels is None:
        return parse_readiness_levels(levels)
    parsed: list[int] = []
    seen: set[int] = set()
    for level in levels:
        n = int(level)
        if n < 1 or n > 9:
            raise ValueError("readiness levels must be between 1 and 9")
        if n not in seen:
            seen.add(n)
            parsed.append(n)
    return parsed


def readiness_field_filters(field: str, levels: Optional[list[int] | str] = None) -> list[dict]:
    """Match documents where ``field`` is at one of the selected levels (OR within field)."""
    parsed = _normalize_level_list(levels)
    if not parsed:
        return []
    should = [{"prefix": {field: f"Level {level}"}} for level in parsed]
    return [{"bool": {"should": should, "minimum_should_match": 1}}]


def readiness_filters(
    *,
    data: Optional[list[int] | str] = None,
    requirements: Optional[list[int] | str] = None,
    coordination: Optional[list[int] | str] = None,
) -> list[dict]:
    """AND across readiness dimensions; OR among selected levels within each dimension."""
    filters: list[dict] = []
    filters.extend(readiness_field_filters("readiness_data", data))
    filters.extend(readiness_field_filters("readiness_requirements", requirements))
    filters.extend(readiness_field_filters("readiness_coordination", coordination))
    return filters


def status_filters(status: Optional[str], *, as_of_year: Optional[int] = None) -> list[dict]:
    """Return ES filter clauses for programme activity relative to a calendar year.

    - active: started on/before the year (or no start) and not ended before it (or no end)
    - inactive: ended before the year, or not yet started
    - all: no extra filters
    """
    normalized = normalize_status(status)
    if normalized == "all":
        return []

    year = as_of_year if as_of_year is not None else datetime.now().year

    started = {
        "bool": {
            "should": [
                {"bool": {"must_not": {"exists": {"field": "start_year"}}}},
                {"range": {"start_year": {"lte": year}}},
            ],
            "minimum_should_match": 1,
        }
    }
    not_ended = {
        "bool": {
            "should": [
                {"bool": {"must_not": {"exists": {"field": "end_year"}}}},
                {"range": {"end_year": {"gte": year}}},
            ],
            "minimum_should_match": 1,
        }
    }

    if normalized == "active":
        return [{"bool": {"filter": [started, not_ended]}}]

    # inactive: ended before year, or starts after year
    return [
        {
            "bool": {
                "should": [
                    {"range": {"end_year": {"lt": year}}},
                    {"range": {"start_year": {"gt": year}}},
                ],
                "minimum_should_match": 1,
            }
        }
    ]
