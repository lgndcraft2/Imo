from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from services.language_detect import detect_nigerian_language
from services.stt import transcribe_voice_audio
from services.tts import synthesize_speech_base64


router = APIRouter(prefix="/api/imo", tags=["imo"])


class DetectLanguageRequest(BaseModel):
    text: str = Field(..., min_length=1)


class ReadAloudRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str = "Idera"


@router.post("/detect-language")
async def detect_language_endpoint(body: DetectLanguageRequest):
    try:
        return await asyncio.to_thread(detect_nigerian_language, body.text)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Language detection failed: {exc}") from exc


@router.post("/read-aloud")
async def read_aloud_endpoint(body: ReadAloudRequest):
    try:
        audio_base64 = await asyncio.to_thread(synthesize_speech_base64, body.text, body.voice)
        return {"audio_base64": audio_base64}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Read-aloud failed: {exc}") from exc


@router.post("/voice-to-form")
async def voice_to_form_endpoint(audio: UploadFile = File(...)):
    try:
        audio_bytes = await audio.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail="Audio upload is empty.")

        result = await asyncio.to_thread(transcribe_voice_audio, audio_bytes)
        if not isinstance(result, dict):
            raise HTTPException(status_code=502, detail="Voice transcription returned invalid JSON.")
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Voice-to-form failed: {exc}") from exc
