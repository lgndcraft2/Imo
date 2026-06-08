from __future__ import annotations

import base64
import os
import re

import requests


YARNGPT_TTS_URL = "https://yarngpt.ai/api/v1/tts"
MAX_CHUNK_LENGTH = 1900


def _sentence_chunks(text: str, max_length: int = MAX_CHUNK_LENGTH) -> list[str]:
    normalized = re.sub(r"\s+", " ", (text or "").strip())
    if not normalized:
        return []

    sentences = re.split(r"(?<=[.!?])\s+", normalized)
    chunks: list[str] = []
    current = ""

    for sentence in sentences:
        if not sentence:
            continue

        if len(sentence) > max_length:
            if current:
                chunks.append(current)
                current = ""
            for start in range(0, len(sentence), max_length):
                chunks.append(sentence[start : start + max_length])
            continue

        candidate = sentence if not current else f"{current} {sentence}"
        if len(candidate) <= max_length:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = sentence

    if current:
        chunks.append(current)

    return chunks


def _collect_streamed_bytes(response: requests.Response) -> bytes:
    audio = bytearray()
    for chunk in response.iter_content(chunk_size=8192):
        if chunk:
            audio.extend(chunk)
    return bytes(audio)


def _request_tts_chunk(text: str, voice: str, api_key: str) -> bytes:
    response = requests.post(
        YARNGPT_TTS_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"text": text, "voice": voice, "response_format": "mp3"},
        stream=True,
        timeout=120,
    )
    try:
        response.raise_for_status()
        return _collect_streamed_bytes(response)
    finally:
        response.close()


def synthesize_speech_base64(text: str, voice: str = "Idera") -> str:
    api_key = os.getenv("YARNGPT_API_KEY")
    if not api_key:
        raise RuntimeError("YARNGPT_API_KEY is not configured.")

    chunks = _sentence_chunks(text)
    if not chunks:
        raise ValueError("Text is required for text-to-speech.")

    audio_bytes = bytearray()
    for chunk in chunks:
        audio_bytes.extend(_request_tts_chunk(chunk, voice, api_key))

    return base64.b64encode(bytes(audio_bytes)).decode("ascii")
