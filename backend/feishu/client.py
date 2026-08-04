"""Feishu Open Platform client: configuration, tenant token management, HTTP transport.

Uses plain httpx (already a project dependency) instead of the official `lark-oapi`
SDK, so it works regardless of Python 3.14 SDK compatibility. Swapping to the SDK
later only requires replacing the internals of `FeishuClient.request`.
"""

import asyncio
import json
import os
import threading
import time
from typing import Any, Optional

import httpx

FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"

# Ensure backend/.env is loaded no matter where the server is started from.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_BACKEND_DIR, ".env"))

# tenant_access_token invalid / expired error codes - retry once after refresh
TOKEN_INVALID_CODES = {99991663, 99991664, 99991668, 99991661}
# Feishu rate-limit error codes - retry with backoff
RATE_LIMIT_CODES = {99991400, 99991401, 99991402}


class FeishuAPIError(Exception):
    """Raised when a Feishu Open Platform API call fails."""

    def __init__(self, code: int, msg: str, path: str = ""):
        self.code = code
        self.msg = msg
        self.path = path
        super().__init__(f"Feishu API error {code} ({path}): {msg}")


def _parse_table_ids(raw: str) -> dict:
    """Parse FEISHU_BITABLE_TABLE_IDS (JSON object like {"courses": "...", ...})."""
    if not raw:
        return {}
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


class FeishuConfig:
    """Environment-driven configuration for the Feishu integration."""

    def __init__(self) -> None:
        self.app_id = os.getenv("FEISHU_APP_ID", "")
        self.app_secret = os.getenv("FEISHU_APP_SECRET", "")
        self.bitable_app_token = os.getenv("FEISHU_BITABLE_APP_TOKEN", "")
        self.bitable_table_ids = _parse_table_ids(os.getenv("FEISHU_BITABLE_TABLE_IDS", ""))
        self.verification_token = os.getenv("FEISHU_VERIFICATION_TOKEN", "")
        self.encrypt_key = os.getenv("FEISHU_ENCRYPT_KEY", "")
        self.teacher_open_id = os.getenv("FEISHU_TEACHER_OPEN_ID", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.app_id and self.app_secret)

    def summary(self) -> dict:
        """Non-secret status snapshot used by GET /api/feishu/health."""
        return {
            "configured": self.is_configured,
            "app_id": (self.app_id[:8] + "...") if self.app_id else "",
            "bitable_configured": bool(self.bitable_app_token),
            "teacher_open_id_configured": bool(self.teacher_open_id),
        }


class TenantTokenManager:
    """Thread-safe cache + refresh for tenant_access_token (valid ~2 hours)."""

    def __init__(self, config: FeishuConfig) -> None:
        self.config = config
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        self._lock = threading.Lock()

    def get(self) -> str:
        with self._lock:
            if self._token and time.time() < self._expires_at - 300:
                return self._token
            self._token = None
            self._refresh()
            return self._token or ""

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._expires_at = 0.0

    def _refresh(self) -> None:
        if not self.config.is_configured:
            raise FeishuAPIError(
                -1,
                "FEISHU_APP_ID / FEISHU_APP_SECRET not configured",
                "auth/v3/tenant_access_token/internal",
            )
        resp = httpx.post(
            f"{FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal",
            json={"app_id": self.config.app_id, "app_secret": self.config.app_secret},
            timeout=15,
        )
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("code", -1) != 0:
            raise FeishuAPIError(
                payload.get("code", -1),
                payload.get("msg", "tenant token refresh failed"),
                "auth/v3/tenant_access_token/internal",
            )
        self._token = payload["tenant_access_token"]
        self._expires_at = time.time() + int(payload.get("expire", 7200))


class FeishuClient:
    """Async HTTP client for Feishu Open Platform server APIs."""

    def __init__(self, config: Optional[FeishuConfig] = None) -> None:
        self.config = config or FeishuConfig()
        self.tokens = TenantTokenManager(self.config)
        self._http = httpx.AsyncClient(timeout=60)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def request(
        self,
        method: str,
        path: str,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
        files: Optional[dict] = None,
        form: Optional[dict] = None,
        retries: int = 2,
    ) -> Any:
        """Send an authenticated request and return the `data` payload.

        Retries once on token-invalid errors (after refreshing the token) and
        applies short backoff on HTTP 429 / Feishu rate-limit codes.
        """
        url = f"{FEISHU_BASE_URL}{path}"
        for attempt in range(retries + 1):
            headers = {"Authorization": f"Bearer {self.tokens.get()}"}
            try:
                if files is not None:
                    resp = await self._http.request(
                        method, url, params=params, files=files, data=form, headers=headers
                    )
                else:
                    resp = await self._http.request(
                        method, url, params=params, json=json_body, headers=headers
                    )
            except httpx.HTTPError as exc:
                raise FeishuAPIError(-1, f"network error: {exc}", path) from exc

            if resp.status_code == 429:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue

            try:
                payload = resp.json()
            except ValueError:
                raise FeishuAPIError(resp.status_code, f"non-JSON response: {resp.text[:200]}", path)

            code = payload.get("code", 0)
            if code == 0:
                return payload.get("data", payload)

            if code in TOKEN_INVALID_CODES and attempt < retries:
                self.tokens.invalidate()
                continue

            if code in RATE_LIMIT_CODES and attempt < retries:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue

            raise FeishuAPIError(code, payload.get("msg", ""), path)

        raise FeishuAPIError(-1, "request failed after retries", path)
