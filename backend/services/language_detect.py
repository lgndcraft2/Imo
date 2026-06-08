from __future__ import annotations

from langdetect import DetectorFactory, detect_langs


DetectorFactory.seed = 0

NIGERIAN_LANGUAGE_MAP = {
    "yo": "Yoruba",
    "ha": "Hausa",
    "ig": "Igbo",
}


def detect_nigerian_language(text: str) -> dict[str, object]:
    cleaned = (text or "").strip()
    if not cleaned:
        return {"language": "unknown", "confidence": 0}

    try:
        candidates = detect_langs(cleaned)
    except Exception:
        return {"language": "unknown", "confidence": 0}

    best_language = "unknown"
    best_confidence = 0.0

    for candidate in candidates:
        code = getattr(candidate, "lang", "").split("-")[0].lower()
        confidence = float(getattr(candidate, "prob", 0.0))
        if code in NIGERIAN_LANGUAGE_MAP and confidence > best_confidence:
            best_language = NIGERIAN_LANGUAGE_MAP[code]
            best_confidence = confidence

    if best_language == "unknown":
        return {"language": "unknown", "confidence": 0}

    return {"language": best_language, "confidence": round(best_confidence, 4)}
