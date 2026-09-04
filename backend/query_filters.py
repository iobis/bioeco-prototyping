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
