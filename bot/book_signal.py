"""Order-book decision engine for Kalshi BTC 15-min up/down markets.

Kalshi's book only has BIDS on each side: a YES bid at p and a NO bid at q.
A NO bid at q is the same as a YES ask at 1 - q. So:
  - YES-side depth = buying pressure for "up"
  - NO-side depth  = buying pressure for "down"

Signals (all computed from the top levels of the book):
  imbalance : (yes_depth - no_depth) / (yes_depth + no_depth), proximity-weighted
  microprice: size-weighted price between best bid and implied ask
  flow      : recent taker buying, YES vs NO
Direction follows the imbalance; conviction (0-3) scales with its strength.
The decision FAILS CLOSED: thin book, wide spread, extreme price, one-sided
book, or flow strongly against the book all veto the trade.

Advice only — never places an order. Paper executor limits still apply.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ── Tunables (start conservative; adjust from paper results) ────────────────
TOP_LEVELS = 5  # levels per side included in depth
DEPTH_DECAY = 0.05  # levels this far ($) below the best count ~37% as much
MIN_TOTAL_DEPTH = 50.0  # weighted contracts, both sides combined
MAX_SPREAD = 0.08  # $ between best YES bid and implied YES ask
IMB_LEVELS = (0.30, 0.50, 0.70)  # |imbalance| for conviction 1 / 2 / 3
MIN_CONVICTION = 1
MIN_ENTRY, MAX_ENTRY = 0.15, 0.80  # avoid lottery tickets and $0.95-to-win-$0.05
FLOW_VETO = 0.60  # veto if taker flow this strongly opposes the book
FLOW_TRADES = 10


@dataclass
class BookDecision:
    direction: str = "pass"  # "up" | "down" | "pass"
    conviction: int = 0  # 0-3
    should_trade: bool = False
    features: dict[str, Any] = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)  # why we vetoed

    def summary(self) -> str:
        f = self.features
        core = (
            f"imb={f.get('imbalance')} micro_shift={f.get('micro_shift')} "
            f"flow={f.get('flow')} spread={f.get('spread')} depth={f.get('total_depth')}"
        )
        if self.should_trade:
            return f"BOOK {self.direction.upper()} conv={self.conviction} | {core}"
        why = "; ".join(self.reasons) or "no edge"
        return f"BOOK NO TRADE ({why}) | {core}"


def _levels(raw: list[dict[str, Any]] | None) -> list[tuple[float, float]]:
    """-> [(price, count)] highest price first, invalid levels dropped."""
    out: list[tuple[float, float]] = []
    for lv in raw or []:
        try:
            p, c = float(lv["price"]), float(lv["count"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0.0 < p < 1.0 and c > 0 and math.isfinite(p) and math.isfinite(c):
            out.append((p, c))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def _weighted_depth(levels: list[tuple[float, float]]) -> float:
    if not levels:
        return 0.0
    best = levels[0][0]
    return sum(
        c * math.exp(-(best - p) / DEPTH_DECAY) for p, c in levels[:TOP_LEVELS]
    )


def _flow(trades: list[dict[str, Any]] | None) -> float | None:
    """(-1..1): +1 = all recent takers bought YES, -1 = all bought NO."""
    yes = no = 0.0
    for t in (trades or [])[:FLOW_TRADES]:
        try:
            n = float(t.get("count", 0))
        except (TypeError, ValueError):
            continue
        side = str(t.get("taker_side", "")).lower()
        if side == "yes":
            yes += n
        elif side == "no":
            no += n
    total = yes + no
    return round((yes - no) / total, 3) if total > 0 else None


def analyze_book(
    order_book_yes: list[dict[str, Any]] | None,
    order_book_no: list[dict[str, Any]] | None,
    trades: list[dict[str, Any]] | None,
    yes_ask: float,
    no_ask: float,
) -> BookDecision:
    """Turn the book into a direction, conviction, and trade/no-trade call."""
    d = BookDecision()
    yes_lv, no_lv = _levels(order_book_yes), _levels(order_book_no)

    if not yes_lv or not no_lv:
        d.reasons.append("one-sided or empty book")
        return d

    best_yes_bid, size_y = yes_lv[0]
    best_no_bid, size_n = no_lv[0]
    implied_yes_ask = round(1.0 - best_no_bid, 4)
    spread = round(implied_yes_ask - best_yes_bid, 4)
    mid = (best_yes_bid + implied_yes_ask) / 2

    # size-weighted microprice: leans toward the side with MORE resting size
    micro = (best_yes_bid * size_n + implied_yes_ask * size_y) / (size_y + size_n)

    dy, dn = _weighted_depth(yes_lv), _weighted_depth(no_lv)
    total_depth = dy + dn
    imbalance = (dy - dn) / total_depth if total_depth > 0 else 0.0
    flow = _flow(trades)

    d.features = {
        "best_yes_bid": round(best_yes_bid, 4),
        "implied_yes_ask": implied_yes_ask,
        "spread": spread,
        "mid": round(mid, 4),
        "microprice": round(micro, 4),
        "micro_shift": round(micro - mid, 4),
        "yes_depth": round(dy, 1),
        "no_depth": round(dn, 1),
        "total_depth": round(total_depth, 1),
        "imbalance": round(imbalance, 3),
        "flow": flow,
    }

    d.direction = "up" if imbalance > 0 else "down" if imbalance < 0 else "pass"
    strength = abs(imbalance)
    d.conviction = sum(strength >= t for t in IMB_LEVELS)

    # ── Vetoes (fail closed) ──
    if d.direction == "pass":
        d.reasons.append("balanced book")
    if spread < 0:
        d.reasons.append("crossed book (stale data)")
    if spread > MAX_SPREAD:
        d.reasons.append(f"spread ${spread:.2f} > ${MAX_SPREAD:.2f}")
    if total_depth < MIN_TOTAL_DEPTH:
        d.reasons.append(f"thin book (depth {total_depth:.0f} < {MIN_TOTAL_DEPTH:.0f})")
    if d.conviction < MIN_CONVICTION:
        d.reasons.append(f"weak imbalance {imbalance:+.2f}")

    entry = yes_ask if d.direction == "up" else no_ask
    if d.direction in ("up", "down") and not (MIN_ENTRY <= entry <= MAX_ENTRY):
        d.reasons.append(f"entry ${entry:.2f} outside [{MIN_ENTRY}, {MAX_ENTRY}]")

    if flow is not None and abs(flow) >= FLOW_VETO:
        if (flow > 0 and d.direction == "down") or (
            flow < 0 and d.direction == "up"
        ):
            d.reasons.append(f"taker flow {flow:+.2f} opposes book")

    d.should_trade = not d.reasons
    return d


def combine_with_jev(book: BookDecision, jev: Any) -> BookDecision:
    """'both' mode: trade only if the book AND Jev agree on direction."""
    out = BookDecision(
        direction=book.direction,
        conviction=min(book.conviction, getattr(jev, "conviction", 0)),
        features=book.features,
        reasons=list(book.reasons),
    )
    if not getattr(jev, "should_trade", False):
        out.reasons.append("Jev says no trade")
    elif jev.direction != book.direction:
        out.reasons.append(
            f"Jev {jev.direction} disagrees with book {book.direction}"
        )
    out.should_trade = book.should_trade and not out.reasons
    return out


def confirm_with_book(
    direction: str, f: dict[str, Any] | None, entry: float
) -> list[str]:
    """Stage-2 check: does the Kalshi book allow (and not fight) this trade?

    `f` is BookDecision.features. Returns a list of veto reasons (empty = OK).
    Unlike analyze_book, a weak imbalance is NOT a veto here — the BTC feed
    already picked the side. The book only has to be tradeable and not
    strongly against us.
    """
    if not f:
        return ["no usable order book"]

    reasons: list[str] = []
    spread = f.get("spread")
    if spread is None or spread < 0:
        reasons.append("bad spread data")
    elif spread > MAX_SPREAD:
        reasons.append(f"spread ${spread:.2f} > ${MAX_SPREAD:.2f}")

    if (f.get("total_depth") or 0.0) < MIN_TOTAL_DEPTH:
        reasons.append(f"thin book (depth {f.get('total_depth')})")

    if not (MIN_ENTRY <= entry <= MAX_ENTRY):
        reasons.append(f"entry ${entry:.2f} outside [{MIN_ENTRY}, {MAX_ENTRY}]")

    imb = f.get("imbalance") or 0.0
    against = (direction == "up" and imb < 0) or (direction == "down" and imb > 0)
    if against and abs(imb) >= IMB_LEVELS[1]:
        reasons.append(f"book imbalance {imb:+.2f} strongly against {direction}")

    flow = f.get("flow")
    if flow is not None and abs(flow) >= FLOW_VETO:
        if (flow > 0 and direction == "down") or (
            flow < 0 and direction == "up"
        ):
            reasons.append(f"taker flow {flow:+.2f} opposes {direction}")

    return reasons
