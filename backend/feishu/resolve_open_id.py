"""Resolve a Feishu open_id for this app from a mobile number or email.

Usage (from backend/):
    python -m feishu.resolve_open_id --mobile 13800000000
    python -m feishu.resolve_open_id --email you@example.com

The result is the open_id of that user *under this app* (open_id is per-app),
which is exactly what FEISHU_TEACHER_OPEN_ID needs.

Requires the app scope contact:user.base:readonly and that the target user is
inside the app's contact visibility scope. When the scope is missing the Feishu
error message contains a console link to grant it.
"""

import argparse
import asyncio
import json
import sys

from .client import FeishuAPIError, FeishuClient, FeishuConfig

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BATCH_GET_ID_PATH = "/contact/v3/users/batch_get_id"


async def resolve(mobiles: list[str], emails: list[str]) -> dict:
    config = FeishuConfig()
    if not config.is_configured:
        raise SystemExit("FEISHU_APP_ID / FEISHU_APP_SECRET not configured in .env")
    client = FeishuClient(config)
    try:
        body: dict = {}
        if mobiles:
            # Feishu expects a country-code prefix; default to +86 for bare
            # 11-digit mainland numbers.
            body["mobiles"] = [
                m if m.startswith("+") or not (m.isdigit() and len(m) == 11 and m.startswith("1"))
                else f"+86{m}"
                for m in mobiles
            ]
        if emails:
            body["emails"] = [e.strip().lower() for e in emails]
        return await client.request(
            "POST",
            BATCH_GET_ID_PATH,
            params={"user_id_type": "open_id"},
            json_body=body,
        )
    finally:
        await client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="resolve open_id for this app")
    parser.add_argument("--mobile", action="append", default=[], help="手机号，可多个")
    parser.add_argument("--email", action="append", default=[], help="邮箱，可多个")
    args = parser.parse_args()
    if not args.mobile and not args.email:
        parser.error("至少提供 --mobile 或 --email")

    try:
        result = asyncio.run(resolve(args.mobile, args.email))
    except FeishuAPIError as exc:
        print(f"查询失败：{exc}")
        if "99991672" in str(exc):
            print("\n应用缺少通讯录权限：点上面报错里的链接，开通 "
                  "contact:user.base:readonly 后重试。")
        return

    items = (result or {}).get("user_list") or []
    found = False
    for item in items:
        lookup = item.get("mobile") or item.get("email") or "?"
        open_id = item.get("user_id") or ""
        if open_id:
            found = True
            print(f"找到：{lookup} -> {open_id}")
            print("把上面 ou_ 开头的值填进 backend/.env 的 FEISHU_TEACHER_OPEN_ID=")
        else:
            print(f"未找到：{lookup}（该账号不在应用可见范围内，或手机号/邮箱不匹配）")
    if not found:
        print("\n原始返回：" + json.dumps(result, ensure_ascii=False)[:500])


if __name__ == "__main__":
    main()
