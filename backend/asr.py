"""Audio transcription abstraction for the demo pipeline.

Providers (ASR_PROVIDER env):
- mock:      returns a canned demo transcript — offline-safe, DEFAULT
- openai:    OpenAI-compatible /audio/transcriptions (e.g. whisper-1); works when
             LLM_PROVIDER/LLM_BASE_URL exposes an audio endpoint
- dashscope: DashScope (百炼) paraformer via the `dashscope` SDK;
             requires `pip install dashscope` and a Model Studio API key

The Feishu Minutes path is parked (permission issue), so this module is the
ASR-agnostic replacement: frontend uploads audio -> this transcribes ->
raw_text enters the existing two-layer evaluation pipeline.
"""

import asyncio
import os
from typing import Optional

import httpx

# A realistic demo transcript for the 动物园 debate topics, used by the mock
# provider so the whole upload -> transcribe -> assess flow can be demoed
# offline / on GitHub Pages without any external API.
MOCK_TRANSCRIPT = (
    "我觉得应该把老鹰放回野外。因为老鹰本来就是天空的动物，"
    "关在动物园里就只能走来走去，很不自由。我同意它康复后放走，"
    "但是要确认它真的能自己抓食物再放，不然它又会受伤。"
)


class ASRError(Exception):
    """Raised when audio transcription fails."""


class ASRClient:
    def __init__(self) -> None:
        self.provider = (os.getenv("ASR_PROVIDER") or "mock").lower().strip()
        self.api_key = os.getenv("ASR_API_KEY") or os.getenv("LLM_API_KEY", "")
        self.base_url = os.getenv("LLM_BASE_URL", "").rstrip("/")
        default_model = "whisper-1" if self.provider == "openai" else "paraformer-realtime-v2"
        self.model = os.getenv("ASR_MODEL") or default_model

    async def transcribe(self, file_path: str) -> str:
        if self.provider == "mock":
            return MOCK_TRANSCRIPT
        if self.provider == "openai":
            return await self._transcribe_openai(file_path)
        if self.provider == "dashscope":
            return await asyncio.to_thread(self._transcribe_dashscope, file_path)
        raise ASRError(f"unknown ASR_PROVIDER: {self.provider}")

    async def transcribe_segments(self, file_path: str) -> list[dict]:
        """Transcribe with per-sentence timestamps: [{start_ms, end_ms, text}].

        Hook for the classroom-recording flow (Scenario B). The mock provider
        returns plausible canned segments so the UI can be developed offline.
        """
        if self.provider == "mock":
            return self._mock_segments()
        if self.provider == "openai":
            return await self._transcribe_openai_segments(file_path)
        if self.provider == "dashscope":
            return await asyncio.to_thread(self._transcribe_dashscope_segments, file_path)
        raise ASRError(f"unknown ASR_PROVIDER: {self.provider}")

    def _mock_segments(self) -> list[dict]:
        sentences = [s.strip() + "。" for s in MOCK_TRANSCRIPT.split("。") if s.strip()]
        segments, cursor = [], 0
        for text in sentences:
            start_ms = cursor
            cursor += max(len(text) * 450, 1800)  # ~0.45s per char, min 1.8s
            segments.append({"start_ms": start_ms, "end_ms": cursor, "text": text})
        return segments

    async def _transcribe_openai(self, file_path: str) -> str:
        if not self.api_key:
            raise ASRError("ASR_API_KEY / LLM_API_KEY not configured")
        url = f"{self.base_url or 'https://api.openai.com/v1'}/audio/transcriptions"
        with open(file_path, "rb") as fh:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    files={
                        "file": (os.path.basename(file_path), fh, "application/octet-stream")
                    },
                    data={"model": self.model},
                )
        if resp.status_code != 200:
            raise ASRError(f"openai transcription failed: HTTP {resp.status_code} {resp.text[:200]}")
        text = (resp.json().get("text") or "").strip()
        if not text:
            raise ASRError("openai transcription returned empty text")
        return text

    async def _transcribe_openai_segments(self, file_path: str) -> list[dict]:
        if not self.api_key:
            raise ASRError("ASR_API_KEY / LLM_API_KEY not configured")
        url = f"{self.base_url or 'https://api.openai.com/v1'}/audio/transcriptions"
        with open(file_path, "rb") as fh:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    files={
                        "file": (os.path.basename(file_path), fh, "application/octet-stream")
                    },
                    data={"model": self.model, "response_format": "verbose_json"},
                )
        if resp.status_code != 200:
            raise ASRError(f"openai transcription failed: HTTP {resp.status_code} {resp.text[:200]}")
        payload = resp.json()
        segments = payload.get("segments") or []
        result = []
        for seg in segments:
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            result.append({
                "start_ms": int(seg.get("start", 0) * 1000),
                "end_ms": int(seg.get("end", 0) * 1000),
                "text": text,
            })
        if not result:
            text = (payload.get("text") or "").strip()
            if text:
                result = [{"start_ms": 0, "end_ms": 0, "text": text}]
        if not result:
            raise ASRError("openai transcription returned empty segments")
        return result

    def _transcribe_dashscope(self, file_path: str) -> str:
        # TODO(verify): exact model name / params per current 百炼 docs.
        try:
            import dashscope
            from dashscope.audio.asr import Recognition
        except ImportError:
            raise ASRError("dashscope SDK not installed — run: pip install dashscope")
        if not self.api_key:
            raise ASRError("ASR_API_KEY / LLM_API_KEY not configured")
        dashscope.api_key = self.api_key
        result = Recognition.call(
            model=self.model,
            file_urls=[file_path],
            format=os.path.splitext(file_path)[1].lstrip("."),
            sample_rate=16000,
        )
        if result.status_code != 200:
            raise ASRError(f"dashscope ASR failed: {result.status_code} {getattr(result, 'code', '')} {getattr(result, 'message', '')}")
        text = (result.get_sentence() or "").strip()
        if not text:
            raise ASRError("dashscope ASR returned empty text")
        return text

    def _transcribe_dashscope_segments(self, file_path: str) -> list[dict]:
        # TODO(verify): parse per-sentence timestamps from the dashscope result.
        text = self._transcribe_dashscope(file_path)
        return [{"start_ms": 0, "end_ms": 0, "text": text}]
