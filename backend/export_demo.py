"""Export the seeded SQLite dataset for the frontend's offline demo mode."""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from pathlib import Path

from sqlalchemy.inspection import inspect

from database import (
    CalibrationRecord,
    Course,
    DimensionTag,
    SessionLocal,
    Student,
    StudentResponse,
    DebateTopic,
    init_db,
)


TABLES = {
    "courses": Course,
    "topics": DebateTopic,
    "students": Student,
    "responses": StudentResponse,
    "tags": DimensionTag,
    "calibrations": CalibrationRecord,
}


def _serialize(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _row(model, item):
    return {
        column.key: _serialize(getattr(item, column.key))
        for column in inspect(model).columns
    }


def export_demo(output: Path) -> dict[str, int]:
    # Safe for a fresh checkout: create missing tables without dropping data.
    init_db()
    db = SessionLocal()
    try:
        payload = {}
        counts = {}
        for name, model in TABLES.items():
            items = db.query(model).order_by(model.id).all()
            payload[name] = [_row(model, item) for item in items]
            counts[name] = len(items)
    finally:
        db.close()

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return counts


def main() -> int:
    default_output = Path(__file__).resolve().parents[1] / "frontend" / "src" / "demo-data.json"
    parser = argparse.ArgumentParser(description="Export SQLite data for frontend demo mode")
    parser.add_argument("--output", type=Path, default=default_output)
    args = parser.parse_args()
    counts = export_demo(args.output.resolve())
    print(f"Exported demo data to {args.output.resolve()}")
    print(", ".join(f"{name}={count}" for name, count in counts.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
