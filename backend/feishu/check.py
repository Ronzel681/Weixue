"""Command-line Feishu auth and Minutes readiness check.

Usage from backend/:
    python -m feishu.check
    python -m feishu.check --minute-token obcn...
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os

from .client import FeishuClient


async def _run(minute_token: str) -> int:
    client = FeishuClient.from_env()
    try:
        result = await client.health_check(minute_token)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] in {"auth_ok", "ready"} else 1
    finally:
        await client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Feishu auth and Minutes access")
    parser.add_argument(
        "--minute-token",
        default=os.getenv("FEISHU_MINUTE_TOKEN", ""),
        help="Optional completed Minutes token; defaults to FEISHU_MINUTE_TOKEN",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args.minute_token.strip()))


if __name__ == "__main__":
    raise SystemExit(main())
