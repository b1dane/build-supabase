"""Jev decision gate — three parallel typed questions in ONE API call.

Jev CLASSIFIES only. It receives pre-computed summary state (<400 tokens)
and returns three independent judgments:

  1. Choice  (direction)       : STRONG_UP | NEUTRAL | STRONG_DOWN
  2. Noul    (fill probability): float 0..1  (will our order fill inside 10s?)
  3. Score   (toxicity)        : int 1..10   (adverse selection risk)

All execution logic, risk checks, and order placement stay in Python code.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from typing import Any

import httpx

from config import config

logger = logging.getLogger("kalshi_bot")

DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone"
VALID_CHOICES = ("STRONG_UP", "NEUTRAL", "STRONG_DOWN")


@dataclass
class JevVerdict:
    """Structured output from the three parallel Jev queries."""

    direction: str = "NEUTRAL"  # STRONG_UP | NEUTRAL | STRONG_DOWN
    direction_confidence: float = 0.0  # 0..1
    fill_probability: float = 0.0  # noul output
    toxicity: int = 5  # 1..10 score
    raw_response: str = ""
    parse_errors: list[str] = field(default_factory=list)
    api_error: str = ""

    @property
    def valid(self) -> bool:
        return (
            not self.parse_errors
            and self.direction in VALID_CHOICES
            and 0.0 <= self.fill_probability <= 1.0
        )

    def summary(self) -> str:
        if self.parse_errors or self.api_error:
            return (
                f"JEV ERROR: {'; '.join(self.parse_errors + [self.api_error])}"
            )
        return (
            f"JEV {self.direction} "
            f"(conf={self.direction_confidence:.2f}, "
            f"fill={self.fill_probability:.2f}, "
            f"tox={self.toxicity})"
        )


# ── Questions payload (typed: choice + noul + score) ────────────────────────

QUESTIONS: dict[str, Any] = {
    "direction": {
        "type": "choice",
        "instructions": (
            "Based on lead crypto momentum and target market pricing, "
            "what is the expected market direction over the target horizon?"
        ),
        "criteria": {
            "STRONG_UP": (
                "Lead indicator shows bullish momentum, "
                "Kalshi implied probability has lagged the move"
            ),
            "NEUTRAL": (
                "No clear directional signal — flat drift, "
                "balanced order book, no lead-lag divergence"
            ),
            "STRONG_DOWN": (
                "Lead indicator shows bearish momentum, "
                "Kalshi implied probability has lagged the move"
            ),
        },
    },
    "fill_probability": {
        "type": "noul",
        "instructions": (
            "Will a passive limit order placed 1 tick inside the spread "
            "get filled within 10 seconds?"
        ),
    },
    "toxicity": {
        "type": "score",
        "instructions": (
            "What is the level of adverse selection risk if our order "
            "fills immediately?"
        ),
        "criteria": [
            "Low toxicity — safe entry, natural flow in our direction",
            "Moderate risk — some adverse selection possible",
            "Elevated risk — order flow is mixed",
            "High toxicity — likely being faded",
            "Extreme toxicity — clear dumping into our order",
        ],
    },
}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _int_clamp(v: Any, lo: int = 1, hi: int = 10) -> int:
    n = _num(v)
    if n is None:
        return 5  # default mid
    return max(lo, min(hi, int(round(n))))


# ── Jev API call ────────────────────────────────────────────────────────────


def _call_jev(state: dict[str, Any]) -> dict[str, Any] | None:
    """Single batched call to Jev System One API.

    Sends all three typed questions in one request.
    Returns the 'answers' dict or None on failure.
    """
    if not config.jev_configured:
        logger.warning("Jev API key not configured")
        return None

    url = getattr(config, "JEV_API_URL", None) or DEFAULT_JEV_API_URL
    headers = {
        "Authorization": f"Bearer {config.JEV_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {"model": "jev-latest", "state": state, "questions": QUESTIONS}

    try:
        resp = httpx.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        answers = data.get("answers") if isinstance(data, dict) else None
        if not isinstance(answers, dict):
            logger.warning(
                "Jev response has no 'answers' (keys=%s)",
                list(data)[:10] if isinstance(data, dict) else type(data).__name__,
            )
            return None
        return answers
    except httpx.HTTPStatusError as exc:
        logger.warning("Jev API HTTP %s: %.200s", exc.response.status_code, exc.response.text)
    except httpx.TimeoutException:
        logger.warning("Jev API timeout (30s)")
    except httpx.RequestError as exc:
        logger.warning("Jev API request error: %s", type(exc).__name__)
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("Jev API returned non-JSON: %s", exc)
    except Exception as exc:
        logger.exception("Unexpected Jev API error: %s", exc)
    return None


# ── Parser ──���───────────────────────────────────────────────────────────────


def _parse_response(raw: dict[str, Any] | None) -> JevVerdict:
    """Parse the three parallel answers. Fail closed on any parse error."""
    result = JevVerdict()

    if raw is None:
        result.api_error = "No response from Jev API"
        return result

    result.raw_response = json.dumps(raw)

    # 1. Direction (choice)
    d = raw.get("direction")
    if isinstance(d, dict):
        choice = d.get("choice")
        if isinstance(choice, str) and choice.strip().upper() in VALID_CHOICES:
            result.direction = choice.strip().upper()
        else:
            result.parse_errors.append(f"Invalid direction: {choice!r}")
        conf = _num(d.get("confidence"))
        if conf is not None:
            result.direction_confidence = conf
    else:
        result.parse_errors.append(f"Unexpected direction format: {type(d).__name__}")

    # 2. Fill probability (noul)
    f = raw.get("fill_probability")
    if isinstance(f, dict):
        noul = f.get("noul")
        if isinstance(noul, bool):
            result.fill_probability = 1.0 if noul else 0.0
        elif _num(noul) is not None and 0.0 <= _num(noul) <= 1.0:
            result.fill_probability = _num(noul)
        else:
            result.parse_errors.append(f"Invalid fill_probability: {noul!r}")
    else:
        result.parse_errors.append(f"Unexpected fill_probability format: {type(f).__name__}")

    # 3. Toxicity (score 1-10)
    t = raw.get("toxicity")
    if isinstance(t, dict):
        score = t.get("score")
        if isinstance(score, bool) or _num(score) is None:
            result.parse_errors.append(f"Invalid toxicity score: {score!r}")
        else:
            result.toxicity = _int_clamp(score)
    else:
        result.parse_errors.append(f"Unexpected toxicity format: {type(t).__name__}")

    return result


# ── Public API ──────────────────────────────────────────────────────────────


def query_jev(state: dict[str, Any]) -> JevVerdict:
    """One call, three judgments. Returns JevVerdict (advice only).

    This is the only public entry point. Jev classifies; code executes.
    """
    result = _parse_response(_call_jev(state))
    logger.info("Jev: %s", result.summary())
    return result
