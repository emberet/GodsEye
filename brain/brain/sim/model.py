"""
The copy-fill model of agent/src/replay/model.ts, line for line: the ONE fee/impact formula the brain simulator uses on
both sides (buyFill / sellFill on Tape.midAt), plus simulateMint for parity.

Every constant, rule and edge case is copied from model.ts (port: brain/research/sim-fidelity/replay_model.py).
tests/test_sim_model.py replays the golden fixtures (GodsEyeBrainData/research/sim-fidelity/parity/cases.json, produced
by the TS code through tsx) and requires every number to 1e-9 relative. Change model.ts and this file together.

Times are integer milliseconds (as in TS: Date.parse(ts)). Prices are SOL per UI token.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

# ---- constants (model.ts) ----
MAX_PLAUSIBLE_RETURN_PCT = 100_000
MAX_IMPACT = 3
MIN_DEPTH = 1
MAX_DEPTH = 5000
PAIR_MAX_GAP_MS = 60_000
PAIR_MIN_MOVE = 0.001
MIN_DEPTH_PAIRS = 3
FALLBACK_LOOKBACK = 400


@dataclass
class ReplayParams:
    delaySec: float = 5
    landSec: float = 2
    sizeSol: float = 0.1
    feeBps: float = 100
    txCostSol: float = 0.0005
    defaultDepthSol: float = 30
    depthWindowSec: float = 600
    fixedDepthSol: Optional[float] = None
    minLeaderBuySol: float = 0.2
    stopLossPct: float = 35
    takeProfitPct: float = 300
    maxHoldHours: float = 48
    trailStopPct: float = 0
    trailArmPct: float = 0
    partialTpPct: float = 0
    partialTpFraction: float = 0.5
    reentryCooldownMin: float = 0
    checkEverySec: float = 60
    ideal: bool = False


DEFAULT_PARAMS = ReplayParams()


def median(xs):
    if not xs:
        return None
    s = sorted(xs)
    m = len(s) >> 1
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


@dataclass
class Obs:
    t: int  # ms
    side: str  # "buy" | "sell"
    price: float  # SOL per token, DEX fee included (average execution price)
    sol: float
    sig: Optional[str] = None


@dataclass
class LeaderSwap:
    t: int
    side: str
    price: float
    solAmount: float
    tokenAmount: float
    tokenBalanceBefore: float
    signature: str


class Tape:
    """obs must be sorted by time (ties in the order the swaps happened: ts, slot, id)."""

    def __init__(self, obs, feeBps, defaultDepth, depthWindowMs, fixedDepth=None):
        self.obs = obs
        self.feeBps = feeBps
        self.defaultDepth = defaultDepth
        self.depthWindowMs = depthWindowMs
        self.fixedDepth = fixedDepth
        self._ts = [o.t for o in obs]
        self._cache: dict[int, float] = {}

    def mid(self, o: Obs) -> float:
        f = self.feeBps / 1e4
        return o.price / (1 + f) if o.side == "buy" else o.price / (1 - f)

    def lastAtOrBefore(self, t) -> int:
        lo, hi = 0, len(self._ts)
        while lo < hi:
            m = (lo + hi) >> 1
            if self._ts[m] <= t:
                lo = m + 1
            else:
                hi = m
        return lo - 1

    def firstAtOrAfter(self, t) -> int:
        lo, hi = 0, len(self._ts)
        while lo < hi:
            m = (lo + hi) >> 1
            if self._ts[m] < t:
                lo = m + 1
            else:
                hi = m
        return lo

    def depthAt(self, i: int) -> float:
        if self.fixedDepth is not None:
            return self.fixedDepth
        c = self._cache.get(i)
        if c is not None:
            return c
        frm = self.firstAtOrAfter(self.obs[i].t - self.depthWindowMs)
        est = self._estimateDepth(frm, i)
        if est is None:
            est = self._estimateDepth(max(0, i - FALLBACK_LOOKBACK), i)
        d = est if est is not None else self.defaultDepth
        self._cache[i] = d
        return d

    def _estimateDepth(self, frm: int, to: int):
        xs = []
        for k in range(frm, to):
            a, b = self.obs[k], self.obs[k + 1]
            if b.t - a.t > PAIR_MAX_GAP_MS:
                continue
            try:
                dln = math.log(self.mid(b) / self.mid(a))
            except (ValueError, ZeroDivisionError):
                continue
            flow = (a.sol if a.side == "buy" else -a.sol) + (b.sol if b.side == "buy" else -b.sol)
            if not math.isfinite(dln) or abs(dln) < PAIR_MIN_MOVE or flow * dln <= 0:
                continue
            xs.append(flow / dln)
        if len(xs) < MIN_DEPTH_PAIRS:
            return None
        m = median(xs)
        return min(MAX_DEPTH, max(MIN_DEPTH, m))

    def midAt(self, t):
        """Fee-free pool price after the last swap at or before t, that swap's own impact added. None if no swap yet."""
        i = self.lastAtOrBefore(t)
        if i < 0:
            return None
        o = self.obs[i]
        depth = self.depthAt(i)
        impact = min(MAX_IMPACT, o.sol / depth)
        m = self.mid(o)
        return {"mid": m * (1 + impact) if o.side == "buy" else m / (1 + impact), "ageSec": (t - o.t) / 1000, "depth": depth, "i": i}

    def density(self, t, windowMs, excludeSig=None) -> int:
        a = self.firstAtOrAfter(t - windowMs)
        b = self.lastAtOrBefore(t + windowMs)
        n = 0
        for k in range(a, b + 1):
            if not excludeSig or self.obs[k].sig != excludeSig:
                n += 1
        return n


def buyFill(mid, solIn, depth, feeBps):
    price = mid * (1 + feeBps / 1e4) * (1 + min(MAX_IMPACT, solIn / depth))
    return {"price": price, "tokens": solIn / price}


def sellFill(mid, tokens, depth, feeBps):
    value = tokens * mid
    price = (mid * (1 - feeBps / 1e4)) / (1 + min(MAX_IMPACT, value / depth))
    return {"price": price, "sol": tokens * price}


def _ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


def simulateMint(tape: Tape, mint: str, swaps: list[LeaderSwap], endT: int, p: ReplayParams) -> list[dict]:
    """Port of simulateMint: one dict per position the copy engine would have opened."""
    out: list[dict] = []
    lagMs = 0 if p.ideal else p.delaySec * 1000
    landMs = 0 if p.ideal else p.landSec * 1000
    txCost = 0 if p.ideal else p.txCostSol
    checkMs = p.checkEverySec * 1000
    holdMs = p.maxHoldHours * 3_600_000
    st = {"pos": None}
    stopped = {"at": -math.inf}

    def finish(closed, reason):
        x = st["pos"]
        if reason in ("stop-loss", "trailing-stop"):
            stopped["at"] = x["scanT"]
        pnl = x["proceeds"] - x["costSol"]
        out.append({
            "mint": mint, "entrySignature": x["entrySignature"], "entryT": x["leaderT"],
            "leaderEntryPrice": x["leaderEntryPrice"], "entryPrice": x["entryPrice"],
            "entryDrift": x["entryPrice"] / x["leaderEntryPrice"] - 1, "costSol": x["costSol"],
            "proceedsSol": x["proceeds"], "pnlSol": pnl,
            "retPct": (pnl / x["costSol"]) * 100 if x["costSol"] > 0 else 0,
            "closed": closed, "exitReason": reason,
            "leaderFirstSellSec": None if x["firstSell"] is None else (x["firstSell"] - x["leaderT"]) / 1000,
            "density": x["density"], "priceAgeSec": x["priceAge"],
        })
        st["pos"] = None

    def sell(tokens, at, leaderPrice=None) -> bool:
        x = st["pos"]
        if p.ideal and leaderPrice is not None:
            sol = tokens * leaderPrice
        else:
            r = tape.midAt(at)
            if not r:
                return False
            sol = tokens * r["mid"] if p.ideal else sellFill(r["mid"], tokens, r["depth"], p.feeBps)["sol"]
        x["proceeds"] += sol - txCost
        x["heldCost"] *= (x["tokens"] - tokens) / x["tokens"]
        x["tokens"] -= tokens
        return True

    def riskScan(to) -> Optional[str]:
        x = st["pos"]
        deadline = x["fillT"] + holdMs
        limit = min(to, deadline)
        i = tape.firstAtOrAfter(x["scanT"])
        while i < len(tape.obs) and tape.obs[i].t <= limit:
            g = x["fillT"] + _ceil_div(int(tape.obs[i].t - x["fillT"]), int(checkMs)) * checkMs
            if g > limit:
                break
            r = tape.midAt(g)
            if r and x["heldCost"] > 0:
                pct = ((x["tokens"] * r["mid"] - x["heldCost"]) / x["heldCost"]) * 100
                x["peakPct"] = max(x["peakPct"], pct)
                trailed = p.trailStopPct > 0 and x["peakPct"] >= p.trailArmPct and 1 + pct / 100 <= (1 + x["peakPct"] / 100) * (1 - p.trailStopPct / 100)
                reason = "stop-loss" if pct <= -p.stopLossPct else "take-profit" if pct >= p.takeProfitPct else "trailing-stop" if trailed else None
                if reason:
                    x["scanT"] = g
                    if sell(x["tokens"], g + landMs):
                        return reason
                elif p.partialTpPct > 0 and not x["partialDone"] and pct >= p.partialTpPct and sell(x["tokens"] * p.partialTpFraction, g + landMs):
                    x["partialDone"] = True
            i = tape.lastAtOrBefore(g) + 1
        x["scanT"] = max(x["scanT"], limit)
        if deadline <= to and sell(x["tokens"], deadline + landMs):
            return "max-hold"
        return None

    for ev in swaps:
        at = ev.t + lagMs
        if st["pos"]:
            reason = riskScan(at)
            if reason:
                finish(True, reason)
        if ev.side == "buy":
            if st["pos"] or ev.solAmount < p.minLeaderBuySol:
                continue
            if p.reentryCooldownMin > 0 and at - stopped["at"] < p.reentryCooldownMin * 60_000:
                continue
            age = 0
            if p.ideal:
                price = ev.price
                tokens = p.sizeSol / price
            else:
                r = tape.midAt(at)
                if not r:
                    continue
                f = buyFill(r["mid"], p.sizeSol, r["depth"], p.feeBps)
                price, tokens, age = f["price"], f["tokens"], r["ageSec"]
            st["pos"] = {
                "entryT": ev.t, "fillT": at, "tokens": tokens, "tokensBought": tokens, "heldCost": p.sizeSol,
                "sizeSol": p.sizeSol, "costSol": p.sizeSol + txCost, "proceeds": 0.0, "entryPrice": price,
                "leaderEntryPrice": ev.price, "entrySignature": ev.signature, "leaderT": ev.t, "firstSell": None,
                "density": tape.density(ev.t, 120_000, ev.signature), "priceAge": age, "scanT": at,
                "peakPct": 0.0, "partialDone": False,
            }
        elif st["pos"]:
            pos = st["pos"]
            if pos["firstSell"] is None:
                pos["firstSell"] = ev.t
            fraction = min(1, ev.tokenAmount / ev.tokenBalanceBefore) if ev.tokenBalanceBefore > 0 else 1
            allx = fraction >= 0.9
            amount = pos["tokens"] if allx else pos["tokens"] * fraction
            if not sell(amount, at, ev.price):
                continue
            pos["scanT"] = at
            if allx or pos["tokens"] <= pos["tokensBought"] * 0.01:
                finish(True, "leader sold" if allx else "leader sold (rest dust)")
    if st["pos"]:
        reason = riskScan(endT)
        if reason:
            finish(True, reason)
        else:
            r = tape.midAt(endT)
            x = st["pos"]
            if r:
                x["proceeds"] += (x["tokens"] * r["mid"] if p.ideal else sellFill(r["mid"], x["tokens"], r["depth"], p.feeBps)["sol"]) - txCost
            finish(False, "still open")
    return out
