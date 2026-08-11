"""Feishu long-connection (WebSocket) listener.

Receives card button callbacks and bot messages WITHOUT a public callback
URL: Feishu delivers the new card-platform interactive callback as a
``card.action.trigger`` event and bot messages as ``im.message.receive_v1``
events, both pushed over the app's outbound WebSocket channel (works from
localhost / behind NAT).

Run (from backend/):
    python -m feishu.ws_listener

Console prerequisites (open.feishu.cn -> this app):
- 事件与回调 -> 订阅方式: "使用长连接接收事件"
- 事件订阅: im.message.receive_v1（接收消息）, card.action.trigger（卡片回传）
"""

import asyncio
import json
import sys
import threading

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    CallBackToast,
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)

from database import SessionLocal

from .bot import BotService
from .card_actions import dispatch_card_action
from .client import FeishuClient, FeishuConfig
from .sync import BitableSyncer

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HELP_REPLY = (
    "思辨星机器人：收到评语确认卡片后，点「确认评分」即可存档并同步多维表格；"
    "点「去网页修改」会直接打开网页批改页。发送“帮助”可随时查看本说明。"
)


def _sync_response_blocking(response_id: int) -> None:
    """Fire-and-forget Bitable sync in a worker thread with its own event
    loop (the SDK's loop stays free to ack the callback quickly)."""

    async def _run() -> None:
        config = FeishuConfig()
        client = FeishuClient(config)
        db = SessionLocal()
        try:
            syncer = BitableSyncer(client, config)
            if syncer.available:
                await syncer.sync_response(db, response_id)
        except Exception:
            # Sync failures must never break the card interaction.
            pass
        finally:
            db.close()
            await client.close()

    asyncio.run(_run())


def _schedule_sync(response_id: int) -> None:
    threading.Thread(
        target=_sync_response_blocking, args=(response_id,), daemon=True
    ).start()


def on_card_action(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    """card.action.trigger: a button on one of our interactive cards was
    clicked. Shares dispatch with the HTTP /api/feishu/card endpoint."""
    value = {}
    if data.event and data.event.action and isinstance(data.event.action.value, dict):
        value = data.event.action.value

    db = SessionLocal()
    try:
        result = dispatch_card_action(db, value, schedule_sync=_schedule_sync)
    except Exception:
        result = {"toast": {"type": "error", "content": "处理失败，请到网页端操作"}}
    finally:
        db.close()

    response = P2CardActionTriggerResponse()
    toast = (result or {}).get("toast") or {}
    if toast:
        # SDK model classes take a single dict, NOT keyword arguments.
        response.toast = CallBackToast(
            {"type": toast.get("type"), "content": toast.get("content")}
        )
    return response


def _reply_help_blocking(message_id: str) -> None:
    async def _run() -> None:
        config = FeishuConfig()
        client = FeishuClient(config)
        try:
            await BotService(client).reply_text(message_id, HELP_REPLY)
        except Exception:
            pass
        finally:
            await client.close()

    asyncio.run(_run())


def on_message_receive(data: P2ImMessageReceiveV1) -> None:
    """im.message.receive_v1: someone messaged the bot. Mirrors the help-ish
    auto-reply behaviour of the HTTP /api/feishu/events endpoint."""
    message = data.event.message if data.event else None
    if message is None or not message.message_id:
        return
    text = ""
    if message.message_type == "text":
        try:
            text = json.loads(message.content or "{}").get("text", "")
        except (TypeError, ValueError):
            text = ""
    if "评语" not in text and "帮助" not in text:
        return
    threading.Thread(
        target=_reply_help_blocking, args=(message.message_id,), daemon=True
    ).start()


def main() -> None:
    config = FeishuConfig()
    if not config.is_configured:
        print("未配置 FEISHU_APP_ID / FEISHU_APP_SECRET，请先填写 backend/.env")
        sys.exit(1)

    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_card_action_trigger(on_card_action)
        .register_p2_im_message_receive_v1(on_message_receive)
        .build()
    )
    client = lark.ws.Client(
        config.app_id,
        config.app_secret,
        event_handler=handler,
        log_level=lark.LogLevel.INFO,
    )
    print("维学思辨星 · 飞书长连接监听启动中……")
    print("  卡片按钮回调: card.action.trigger")
    print("  机器人消息:   im.message.receive_v1")
    print("（保持本窗口运行；Ctrl+C 退出）")
    client.start()


if __name__ == "__main__":
    main()
