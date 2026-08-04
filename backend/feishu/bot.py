"""Feishu bot (IM) integration: message/card sending + event callback verification.

APIs (verified 2026-08):
- Send message: POST /open-apis/im/v1/messages?receive_id_type=open_id
- Reply:        POST /open-apis/im/v1/messages/{message_id}/reply
- Event callbacks: answer `challenge` and verify token (Encrypt Key optional)

Rate limits: 1000 req/min, 50 req/s overall; 5 QPS per user - batch sends carefully.
"""

import base64
import json
from typing import Any, Optional

from .client import FeishuClient, FeishuConfig

SEND_MESSAGE_PATH = "/im/v1/messages"
REPLY_MESSAGE_PATH = "/im/v1/messages/{message_id}/reply"


class BotService:
    def __init__(self, client: FeishuClient) -> None:
        self.client = client

    async def send_text(self, open_id: str, text: str) -> Any:
        return await self.client.request(
            "POST",
            SEND_MESSAGE_PATH,
            params={"receive_id_type": "open_id"},
            json_body={
                "receive_id": open_id,
                "msg_type": "text",
                "content": json.dumps({"text": text}, ensure_ascii=False),
            },
        )

    async def send_card(self, open_id: str, card: dict) -> Any:
        return await self.client.request(
            "POST",
            SEND_MESSAGE_PATH,
            params={"receive_id_type": "open_id"},
            json_body={
                "receive_id": open_id,
                "msg_type": "interactive",
                "content": json.dumps(card, ensure_ascii=False),
            },
        )

    async def reply_text(self, message_id: str, text: str) -> Any:
        return await self.client.request(
            "POST",
            REPLY_MESSAGE_PATH.format(message_id=message_id),
            json_body={
                "msg_type": "text",
                "content": json.dumps({"text": text}, ensure_ascii=False),
            },
        )

    @staticmethod
    def handle_event(config: FeishuConfig, body: dict) -> dict:
        """Validate a Feishu event callback payload.

        Returns {"challenge": ...} for url_verification, or the (decrypted) inner
        event body for real events. Raises ValueError when the token mismatches.
        """
        if not isinstance(body, dict):
            raise ValueError("invalid event payload")
        if body.get("encrypt"):
            inner = BotService._decrypt_event(config.encrypt_key, body["encrypt"])
            body = json.loads(inner)
        token = body.get("token", "")
        if config.verification_token and token != config.verification_token:
            raise ValueError("event verification token mismatch")
        if body.get("type") == "url_verification":
            return {"challenge": body.get("challenge", "")}
        return body

    @staticmethod
    def _decrypt_event(encrypt_key: str, payload_b64: str) -> str:
        """AES-256-CBC decrypt of Feishu encrypted event payloads.

        Feishu uses the Encrypt Key directly: key = first 32 bytes of the key
        string, iv = first 16 bytes. Requires the `cryptography` package.
        """
        if not encrypt_key:
            raise ValueError("FEISHU_ENCRYPT_KEY not configured but event is encrypted")
        try:
            from cryptography.hazmat.primitives import padding
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            raise ValueError(
                "cryptography not installed; required when FEISHU_ENCRYPT_KEY is set"
            )
        key = encrypt_key.encode("utf-8")[:32]
        iv = key[:16]
        cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        plain = decryptor.update(base64.b64decode(payload_b64)) + decryptor.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return (unpadder.update(plain) + unpadder.finalize()).decode("utf-8")
