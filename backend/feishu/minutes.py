"""Feishu Minutes (妙记) integration: audio upload -> minute creation -> transcript.

Verified against official docs (2026-08):
- Media upload:   POST /open-apis/drive/v1/medias/upload_all  (multipart)
- Minute create:  endpoint path below is marked TODO - confirm in open platform console
- Minute info:    GET  /open-apis/minutes/v1/minutes/{minute_token}
- Transcript:     GET  /open-apis/minutes/v1/minutes/{minute_token}/transcript
- Event:          minutes.minute.generated_v1 (subscription) - preferred over polling

File limits (official docs): audio wav/mp3/m4a/aac/ogg/wma/amr,
video avi/wmv/mov/mp4/m4v/mpeg/ogg/flv; max 6 hours; max 6 GB.
"""

import asyncio
import os
import time
from typing import Optional

from .client import FeishuAPIError, FeishuClient, FeishuConfigurationError

DRIVE_UPLOAD_PATH = "/drive/v1/medias/upload_all"
MINUTE_CREATE_PATH = os.getenv("FEISHU_MINUTE_CREATE_PATH", "").strip()
MINUTE_INFO_PATH = "/minutes/v1/minutes/{minute_token}"
TRANSCRIPT_PATH = "/minutes/v1/minutes/{minute_token}/transcript"

SUPPORTED_EXTENSIONS = {
    ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".wma", ".amr",
    ".avi", ".wmv", ".mov", ".mp4", ".m4v", ".mpeg", ".flv",
}


def _token_from_url(minute_url: str) -> str:
    """Extract minute_token from a minute_url like https://*.feishu.cn/minutes/obcnxxx."""
    if not minute_url:
        return ""
    return minute_url.rstrip("/").split("/")[-1].split("?")[0]


class MinutesService:
    def __init__(self, client: FeishuClient) -> None:
        self.client = client

    async def upload_media(
        self,
        file_path: str,
        parent_type: str = "ccm_import_open",
        parent_node: str = "",
    ) -> str:
        """Upload a local audio/video file to Feishu drive, return file_token."""
        if not os.path.isfile(file_path):
            raise FeishuAPIError(-1, f"file not found: {file_path}")
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise FeishuAPIError(
                -1,
                f"unsupported media type {ext}; supported: {sorted(SUPPORTED_EXTENSIONS)}",
            )
        file_name = os.path.basename(file_path)
        with open(file_path, "rb") as fh:
            data = await self.client.request(
                "POST",
                DRIVE_UPLOAD_PATH,
                files={"file": (file_name, fh)},
                form={
                    "file_name": file_name,
                    "parent_type": parent_type,
                    "parent_node": parent_node,
                    "size": str(os.path.getsize(file_path)),
                },
            )
        file_token = (data or {}).get("file_token", "")
        if not file_token:
            raise FeishuAPIError(-1, "upload_media: missing file_token in response", DRIVE_UPLOAD_PATH)
        return file_token

    async def create_minute(self, file_token: str) -> dict:
        """Create a Minute from an uploaded file_token.

        Returns {"minute_token": ..., "minute_url": ...}. The transcript is generated
        asynchronously, so callers should poll `get_transcript` or use the
        minutes.minute.generated_v1 event.
        """
        if not MINUTE_CREATE_PATH:
            raise FeishuConfigurationError(
                "Feishu audio-to-Minutes creation endpoint is not verified; "
                "set FEISHU_MINUTE_CREATE_PATH only after validating it in API Explorer"
            )
        data = await self.client.request(
            "POST", MINUTE_CREATE_PATH, json_body={"file_token": file_token}
        )
        data = data or {}
        minute_token = (
            data.get("minute_token", "")
            or _token_from_url(data.get("minute_url", ""))
        )
        if not minute_token:
            raise FeishuAPIError(-1, "create_minute: missing minute_token", MINUTE_CREATE_PATH)
        return {"minute_token": minute_token, "minute_url": data.get("minute_url", "")}

    async def get_transcript(self, minute_token: str) -> str:
        """Fetch the speech-to-text transcript of a minute (plain text)."""
        return (await self.client.export_minute_transcript(minute_token)).strip()

    async def wait_for_transcript(
        self, minute_token: str, timeout: int = 600, interval: int = 10
    ) -> str:
        """Poll until the transcript is ready. Prefer event subscription in production."""
        deadline = time.time() + timeout
        last_error: Optional[str] = None
        while time.time() < deadline:
            try:
                text = await self.get_transcript(minute_token)
                if text:
                    return text
            except FeishuAPIError as exc:
                # Transcript may error/404 while the minute is still generating.
                last_error = str(exc)
            await asyncio.sleep(interval)
        suffix = f" ({last_error})" if last_error else ""
        raise FeishuAPIError(-1, f"transcript not ready within {timeout}s{suffix}")

    async def import_audio(self, file_path: str, wait: bool = True, timeout: int = 600) -> dict:
        """Convenience: upload -> create minute -> (optional) wait for transcript."""
        file_token = await self.upload_media(file_path)
        minute = await self.create_minute(file_token)
        if wait:
            minute["transcript"] = await self.wait_for_transcript(minute["minute_token"], timeout=timeout)
        return minute
