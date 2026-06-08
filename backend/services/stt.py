from __future__ import annotations

import base64
import json
import os
import re
import tempfile
from pathlib import Path

import requests

try:
    from google import genai
except Exception:  # pragma: no cover - fallback path
    genai = None

try:
    from google.genai import types as genai_types
except Exception:  # pragma: no cover - fallback path
    genai_types = None

from app.core.config import settings


GEMINI_MODEL_NAME = "gemini-1.5-flash"
VOICE_TO_FORM_PROMPT = (
    "This audio is in Yoruba, Hausa, or Igbo. Transcribe it, translate it to English, "
    "and return ONLY a valid JSON object of key-value pairs suitable for filling a web form. "
    "No markdown, no explanation, just raw JSON."
)
GEMINI_GENERATE_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL_NAME}:generateContent"
)


def _gemini_keys() -> list[str]:
    keys = list(settings.gemini_keys)
    if not keys:
        raise RuntimeError("No Gemini API key is configured.")
    return keys


def _save_temp_audio(audio_bytes: bytes) -> Path:
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".webm")
    try:
        temp_file.write(audio_bytes)
        temp_file.flush()
    finally:
        temp_file.close()
    return Path(temp_file.name)


def _strip_markdown_fences(text: str) -> str:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def _extract_json_object(text: str) -> dict:
    cleaned = _strip_markdown_fences(text)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("Gemini did not return a JSON object.")

    payload = cleaned[start : end + 1]
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError("Gemini returned JSON that is not an object.")
    return data


def _sdk_audio_part(audio_bytes: bytes):
    if genai_types is None or not hasattr(genai_types, "Part") or not hasattr(genai_types.Part, "from_bytes"):
        raise RuntimeError("google-genai audio Part support is unavailable.")
    return genai_types.Part.from_bytes(data=audio_bytes, mime_type="audio/webm")


def _sdk_transcribe(audio_bytes: bytes, api_key: str) -> str:
    if genai is None:
        raise RuntimeError("google-genai is not available.")

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=GEMINI_MODEL_NAME,
        contents=[VOICE_TO_FORM_PROMPT, _sdk_audio_part(audio_bytes)]
    )
    raw_text = getattr(response, "text", "") or ""
    return raw_text


def _rest_transcribe(audio_bytes: bytes, api_key: str) -> str:
    encoded_audio = base64.b64encode(audio_bytes).decode("ascii")
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": VOICE_TO_FORM_PROMPT},
                    {
                        "inlineData": {
                            "mimeType": "audio/webm",
                            "data": encoded_audio,
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1024,
        },
    }

    response = requests.post(
        f"{GEMINI_GENERATE_URL}?key={api_key}",
        json=payload,
        timeout=120,
    )
    response.raise_for_status()
    data = response.json()
    parts = data["candidates"][0]["content"]["parts"]
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict))


def transcribe_voice_audio(audio_bytes: bytes) -> dict:
    if not audio_bytes:
        raise ValueError("Audio is required.")

    temp_path = _save_temp_audio(audio_bytes)
    last_error: Exception | None = None

    try:
        for api_key in _gemini_keys():
            try:
                raw_text = _sdk_transcribe(audio_bytes, api_key)
                if not raw_text.strip():
                    raise RuntimeError("Gemini returned an empty transcription.")
                return _extract_json_object(raw_text)
            except Exception as sdk_error:
                last_error = sdk_error

            try:
                raw_text = _rest_transcribe(audio_bytes, api_key)
                if not raw_text.strip():
                    raise RuntimeError("Gemini returned an empty transcription.")
                return _extract_json_object(raw_text)
            except Exception as rest_error:
                last_error = rest_error

        if last_error:
            raise RuntimeError(f"Gemini transcription failed: {last_error}")
        raise RuntimeError("Gemini transcription failed.")
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
