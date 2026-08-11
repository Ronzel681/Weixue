#!/usr/bin/env python3
"""Audio preprocessing utilities for the Weixue ASR pipeline.

What this module provides:

- ``to_wav16k``      — convert any ffmpeg-readable audio (m4a / webm / ogg /
                       mp3 / ...) to 16 kHz mono PCM WAV, the canonical input
                       format of qwen_asr and the dashscope paraformer SDK.
- ``probe_duration`` — best-effort duration (seconds) via ffprobe.
- ``make_sample_audio`` — produce a 30–60 s classroom sample recording for
                       demos and ASR verification.

CLI::

    python audio_utils.py convert INPUT [OUTPUT]   # transcode to 16k mono wav
    python audio_utils.py sample  [OUTPUT]         # build a sample recording
    python audio_utils.py info    INPUT            # print duration/format

ffmpeg is required for ``convert``. If it is missing the tool exits with a
platform-specific install hint instead of a stack trace. ``sample`` can build
a 16k WAV without ffmpeg on macOS (system TTS + afconvert) and will run the
result through ``to_wav16k`` when ffmpeg is available.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import tempfile

# ── Errors & hints ──────────────────────────────────────────────────────


class AudioToolError(RuntimeError):
    """Raised for any user-fixable audio tooling problem."""


FFMPEG_INSTALL_HINT = """\
未检测到 ffmpeg，请先安装：
  - macOS:        brew install ffmpeg
  - Debian/Ubuntu: sudo apt-get install ffmpeg
  - Windows:      winget install Gyan.FFmpeg  (或 choco install ffmpeg)
安装后重新打开终端再运行本工具。"""


def find_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def find_ffprobe() -> str | None:
    return shutil.which("ffprobe")


def require_ffmpeg() -> str:
    path = find_ffmpeg()
    if not path:
        raise AudioToolError(FFMPEG_INSTALL_HINT)
    return path


def _run(cmd: list[str], timeout: int = 180) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError as exc:
        raise AudioToolError(f"找不到可执行文件：{cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise AudioToolError(f"命令超时（{timeout}s）：{' '.join(cmd[:3])} …") from exc


# ── Conversion ──────────────────────────────────────────────────────────


def to_wav16k(src: str, dst: str | None = None) -> str:
    """Convert ``src`` to 16 kHz mono s16le WAV; returns the output path.

    Accepts anything ffmpeg can demux (m4a/webm/ogg/mp3/aac/amr/wma/flac/
    mp4/mov …). Video containers are stripped (``-vn``).
    """
    src = os.path.abspath(os.path.expanduser(src))
    if not os.path.isfile(src):
        raise AudioToolError(f"输入文件不存在：{src}")
    ffmpeg = require_ffmpeg()

    if dst is None:
        root, _ = os.path.splitext(src)
        dst = f"{root}.16k.wav"
    dst = os.path.abspath(os.path.expanduser(dst))
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-i", src,
        "-vn",                 # drop video track (mp4/mov recordings)
        "-ac", "1",            # mono
        "-ar", "16000",        # 16 kHz
        "-c:a", "pcm_s16le",   # PCM WAV
        dst,
    ]
    proc = _run(cmd)
    if proc.returncode != 0:
        raise AudioToolError(
            f"ffmpeg 转码失败（{os.path.basename(src)}）：\n{proc.stderr.strip()[:500]}"
        )
    if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
        raise AudioToolError("ffmpeg 未产生有效输出文件")
    return dst


def probe_duration(src: str) -> float | None:
    """Return duration in seconds, or None when ffprobe is unavailable."""
    ffprobe = find_ffprobe()
    if not ffprobe or not os.path.isfile(src):
        return None
    proc = _run(
        [
            ffprobe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            src,
        ],
        timeout=30,
    )
    if proc.returncode != 0:
        return None
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


# ── Sample audio generation ─────────────────────────────────────────────

# A realistic multi-sentence classroom utterance for the 动物园 unit debates —
# long enough (~45 s at the default Tingting speaking rate) to exercise the
# 30–60 s acceptance window.
SAMPLE_SCRIPT = (
    "我觉得应该把受伤的老鹰放回野外。因为老鹰本来就是属于天空的动物，"
    "如果一直把它关在笼子里，它就不能自由地飞翔了，那它会很难过。"
    "而且，野外才是老鹰真正的家，它有自己找食物的本领，能自己照顾自己。"
    "不过我也想过，如果它的伤还没有完全好，可以先让医生照顾它一段时间，"
    "等它完全康复了，再把它送回大自然。"
    "我还想补充一点，动物园里的动物虽然有人喂养，可是它们整天被人看着，"
    "不能做自己想做的事情，这样的生活对动物来说并不快乐。"
)

MACOS_VOICES = ("Tingting", "Sin-ji", "Mei-Jia")


def _synthesize_macos(text: str, out_wav: str, voice: str = "Tingting") -> None:
    """macOS-only path: system TTS -> AIFF -> 16k mono WAV via afconvert."""
    with tempfile.TemporaryDirectory() as tmp:
        aiff = os.path.join(tmp, "sample.aiff")
        proc = _run(["say", "-v", voice, "-o", aiff, text])
        if proc.returncode != 0 or not os.path.isfile(aiff):
            raise AudioToolError(
                f"macOS 语音合成失败（声音 {voice}）：{proc.stderr.strip()[:200]}"
            )
        proc = _run(
            ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, out_wav]
        )
        if proc.returncode != 0 or not os.path.isfile(out_wav):
            raise AudioToolError(f"afconvert 转 WAV 失败：{proc.stderr.strip()[:200]}")


def make_sample_audio(dst: str | None = None, voice: str = "Tingting") -> str:
    """Build a 30–60 s sample classroom recording; returns the output path.

    macOS: synthesized with the system Chinese voice (no ffmpeg needed), then
    normalized through ``to_wav16k`` when ffmpeg is available. Other systems:
    record a real clip and use the ``convert`` subcommand instead.
    """
    if dst is None:
        dst = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "data", "sample_class_audio.wav"
        )
    dst = os.path.abspath(os.path.expanduser(dst))
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)

    if platform.system() != "Darwin":
        raise AudioToolError(
            "示例音频自动生成仅支持 macOS（系统 TTS）。\n"
            "请录制一段 30–60 秒的课堂音频（m4a/mp3/wav），然后运行：\n"
            "  python audio_utils.py convert <录音文件> " + dst
        )

    _synthesize_macos(SAMPLE_SCRIPT, dst, voice=voice)

    # Normalize through ffmpeg when present so the sample exercises the exact
    # same pipeline as uploaded classroom recordings.
    if find_ffmpeg():
        normalized = to_wav16k(dst, dst + ".tmp.wav")
        os.replace(normalized, dst)

    duration = probe_duration(dst)
    note = f"时长约 {duration:.1f} 秒" if duration else "无法探测时长（缺 ffprobe）"
    print(f"示例音频已生成：{dst}（{note}）")
    return dst


# ── CLI ─────────────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd = argv[1]
    try:
        if cmd == "convert":
            if len(argv) < 3:
                print("用法: python audio_utils.py convert INPUT [OUTPUT]")
                return 2
            out = to_wav16k(argv[2], argv[3] if len(argv) > 3 else None)
            duration = probe_duration(out)
            suffix = f"（时长约 {duration:.1f} 秒）" if duration else ""
            print(f"转码完成：{out}{suffix}")
        elif cmd == "sample":
            make_sample_audio(argv[2] if len(argv) > 2 else None)
        elif cmd == "info":
            if len(argv) < 3:
                print("用法: python audio_utils.py info INPUT")
                return 2
            duration = probe_duration(argv[2])
            if duration is None:
                print("无法探测（缺 ffprobe 或文件不存在）")
                return 1
            size = os.path.getsize(argv[2])
            print(f"{argv[2]}：时长 {duration:.1f} 秒，{size / 1024:.0f} KB")
        else:
            print(f"未知子命令：{cmd}（可用：convert / sample / info）")
            return 2
    except AudioToolError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
