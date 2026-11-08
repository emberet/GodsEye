"""
The entry features of ONE leader buy, from exactly what the server holds when it decides (features.yaml `entry`,
`gates`). This is the reference: agent/src/brain/features.ts computes the same from the same inputs, spec/golden/
pins both, and the offline bulk build (build.py) is tested against it.

A case is a dict in the server's shapes (times: ISO strings for DB rows, epoch ms for in-memory state):

    now            decision time t (ISO)
    swap           the incoming swap: wallet, mint, side, sol_amount, price_sol, token_amount, token_balance_before,
                   venue, fee_lamports, ts (ISO block time = T), signature
    ring           StreamState ring of the mint: [{wallet, side, sol, price, ts, at, ok}] (ms)
    hist_max       the mint's highest ok price that left the ring: {price, ts, at} (ms) or null
    first_seen     StreamState.firstSeen(mint): {firstSeenAt, firstOkPrice, firstOkAt, creator, creatorResolvedAt} (ms) or null
    leader_holding StreamState.leaderHolding(leader, mint): {buyTs, postBuyTokens, soldTokens} or null
    active_wallets_1h  StreamState.activeWallets1h(t), or null
    screen         the paper screen if it returned before t: {failed, lp_locked_pct} or null
    db             wallet_swaps: the leader's rows the scan returns [{mint, side, sol_amount, ts}]
                   token_info: {pool_created_at, launch_checked_at} or null
                   creator_coins: brain_token_first_seen rows with this creator [{mint, first_seen_at}]
                   social_scores: {score, model_version, updated_at} or null; social_model_version: the live one
    ledgers        mirror: [{resolved_at, y, lr}]  ps: [{avail_at, r, done}]  dd: [{avail_at, dead, done}]

entry_raw(case) -> {feature: raw value (NaN = missing; venue_group a level string)} and gate(case, raw) -> the first
gate that fires, or None. Windows follow conventions.point_in_time: swaps by block time [T - W, T) and delivered before
t (ring `at` < t; the DB holds only what arrived), ledger rows by availability time [t - W, t). Times are compared as
integer epoch ms, like JS Date.parse, so a value exactly on a window edge lands on the same side in both languages.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np

from brain.features import spec

NAN = float("nan")
DAY_MS = 86_400_000
WINDOW_7D = 7 * DAY_MS
WINDOW_24H = DAY_MS
FLOW_SEC = 300.0  # m_buyers_5m / m_buysol_5m
HIGH_CUT_SEC = 60.0  # dd_from_high ignores the last minute
FLIP_SEC = 60.0  # lf_flip60_7d
FLOW_MS, HIGH_CUT_MS, FLIP_MS = 300_000, 60_000, 60_000
MIN_STYLE_SOL = 0.05  # a leader buy counted by the style features
MIN_LEADER_BUY_SOL = 0.2  # copy-eligible (MIN_LEADER_BUY_SOL)
MAX_COPY_DELAY_SEC = 60.0
CP_SHRINK = 20.0
AGE_CAP_MIN = 10_080.0
YOUNG_AMM_MIN = 10.0
YOUNG_AMM_VENUES = frozenset({"pumpswap", "meteora", "meteora dbc", "raydium", "raydium launchlab", "orca"})
HIPRICE_SOL = 1e-4
SOCIAL_SHRINK = 18.0
SOCIAL_MAX_AGE = 48 * 3_600_000
SCREEN_LP_MIN_PCT = 1.0
VIA_BOT = " (via bot)"


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def msec(v) -> int | None:
    """A time as integer epoch ms: ISO strings (DB rows) or epoch ms numbers (in-memory state)."""
    if v is None:
        return None
    if isinstance(v, str):
        return (datetime.fromisoformat(v.replace("Z", "+00:00")) - _EPOCH) // timedelta(milliseconds=1)
    return int(round(float(v)))


def num(v) -> float:
    if v is None:
        return NAN
    try:
        x = float(v)
    except (TypeError, ValueError):
        return NAN
    return x if math.isfinite(x) else NAN


def strip_venue(venue) -> tuple[str | None, bool]:
    """(venue lower-cased without ' (via bot)', whether it had it); (None, False) when missing."""
    if venue is None or (isinstance(venue, float) and math.isnan(venue)) or not str(venue).strip():
        return None, False
    v = str(venue).strip().lower()
    return v.replace(VIA_BOT, "").strip(), VIA_BOT in v


def venue_group(venue) -> str:
    """features.yaml venue_group: the first matching rule of venue_groups; 'missing' without a venue."""
    v, _ = strip_venue(venue)
    if v is None:
        return "missing"
    for g in spec.venue_groups():
        if "venues" in g and v in g["venues"]:
            return g["level"]
        if "prefix" in g and v.startswith(g["prefix"]):
            return g["level"]
    return spec.OTHER


def log_outcome(y: float) -> float:
    """ln(1 + clip(y, -0.99, 10)): what cp_lrshr_7d sums (ledger.ts logOutcome)."""
    return math.log(1.0 + min(max(y, -0.99), 10.0))


def entry_raw(case: dict) -> dict:
    sw = case["swap"]
    T = msec(sw["ts"])
    t = msec(case["now"])
    leader, mint = sw["wallet"], sw["mint"]
    sol, price = num(sw.get("sol_amount")), num(sw.get("price_sol"))
    db = case.get("db") or {}
    led = case.get("ledgers") or {}
    out: dict = {}

    # ---- the mirror / ps / dd ledgers: rows available in [t - 7 d, t)
    def in7(at) -> bool:
        a = msec(at)
        return a is not None and t - WINDOW_7D <= a < t

    rows = [r for r in led.get("mirror", []) if r.get("y") is not None and in7(r.get("resolved_at"))]
    n = len(rows)
    lr = sum(num(r["lr"]) if r.get("lr") is not None else log_outcome(num(r["y"])) for r in rows)
    out["cp_lrshr_7d"] = lr / (n + CP_SHRINK)
    out["cp_n_7d"] = float(n)
    out["cp_win_7d"] = sum(1 for r in rows if num(r["y"]) > 0) / n if n else NAN
    ps = [num(r["r"]) for r in led.get("ps", []) if r.get("done") and r.get("r") is not None and in7(r.get("avail_at"))]
    out["ps_r_7d"] = sum(ps) / len(ps) if ps else NAN
    dd = [num(r["dead"]) for r in led.get("dd", []) if r.get("done") and r.get("dead") is not None and in7(r.get("avail_at"))]
    out["dd_rate_7d"] = sum(dd) / len(dd) if dd else NAN

    # ---- the leader's wallet_swaps scan: block time in [T - 7 d, T)
    scan = [(r["mint"], r["side"], num(r["sol_amount"]), msec(r["ts"])) for r in db.get("wallet_swaps", [])]
    scan = [s for s in scan if s[3] is not None and T - WINDOW_7D <= s[3] < T]
    buys = [s for s in scan if s[1] == "buy" and s[2] >= MIN_STYLE_SOL]
    out["b_first_7d"] = len({s[0] for s in buys}) / len(buys) if buys else NAN
    out["b_n_24h"] = float(sum(1 for s in buys if s[3] >= T - WINDOW_24H))
    out["leader_n_prior7"] = float(len({s[0] for s in buys if s[2] >= MIN_LEADER_BUY_SOL}))
    out["b_size_ratio"] = math.log(sol) - sum(math.log(s[2]) for s in buys) / len(buys) if buys and sol > 0 else NAN
    sells: dict[str, list[float]] = {}
    for s in scan:
        if s[1] == "sell":
            sells.setdefault(s[0], []).append(s[3])
    done = [s for s in buys if s[3] < T - FLIP_MS]
    flips = sum(1 for s in done if any(s[3] <= x <= s[3] + FLIP_MS for x in sells.get(s[0], ())))
    out["lf_flip60_7d"] = flips / len(done) if done else NAN

    # ---- the incoming swap
    fee = num(sw.get("fee_lamports"))
    out["log_fee"] = math.log1p(fee) if fee >= 0 else NAN
    out["venue_group"] = venue_group(sw.get("venue"))
    out["venue_via_bot"] = 1.0 if strip_venue(sw.get("venue"))[1] else 0.0
    out["sfx_pump"] = 1.0 if str(mint).endswith("pump") else 0.0
    out["log_mcap_sol"] = math.log10(price * 1e9) if price > 0 else NAN
    h = case.get("leader_holding")
    post = num(h.get("postBuyTokens")) if h else NAN
    out["leader_sold_at_decision"] = min(1.0, max(0.0, num(h.get("soldTokens")) / post)) if h and post > 0 else 0.0
    out["signal_lateness_sec"] = max(0.0, (t - T) / 1000.0)

    # ---- the coin: first sighting, creator, highs, launch time, the 5-min crowd
    fs = case.get("first_seen")
    fsa = msec(fs.get("firstSeenAt")) if fs else None
    out["mint_first_seen_age_min"] = min(AGE_CAP_MIN, (t - fsa) / 60_000.0) if fsa is not None and fsa < T else NAN
    creator = fs.get("creator") if fs else None
    if creator:
        others = [r for r in db.get("creator_coins", []) if r["mint"] != mint and msec(r["first_seen_at"]) is not None
                  and t - WINDOW_7D <= msec(r["first_seen_at"]) < t]
        out["cr_seen_prior_7d"] = float(len(others))
    else:
        out["cr_seen_prior_7d"] = NAN
    fop = num(fs.get("firstOkPrice")) if fs else NAN
    foa = msec(fs.get("firstOkAt")) if fs else None
    out["ret_since_first"] = math.log(price / fop) if fop > 0 and foa is not None and foa < T and price > 0 else NAN

    ring = [(r["wallet"], r["side"], num(r["sol"]), num(r["price"]), msec(r["ts"]), msec(r["at"]), bool(r["ok"]))
            for r in case.get("ring", [])]
    ring = [r for r in ring if r[5] < t]  # delivered before t
    highs = [r[3] for r in ring if r[6] and T - WINDOW_7D <= r[4] < T - HIGH_CUT_MS]
    hm = case.get("hist_max")
    if hm and msec(hm["at"]) < t and T - WINDOW_7D <= msec(hm["ts"]) < T - HIGH_CUT_MS:
        highs.append(num(hm["price"]))
    out["dd_from_high"] = math.log(price / max(highs)) if highs and price > 0 else NAN
    ti = db.get("token_info")
    pca = msec(ti.get("pool_created_at")) if ti else None
    lca = msec(ti.get("launch_checked_at")) if ti else None
    out["log_token_age"] = math.log1p(max(0.0, (T - pca) / 1000.0)) if pca is not None and lca is not None and lca < t else NAN
    crowd = [r for r in ring if r[0] != leader and r[1] == "buy" and r[6] and T - FLOW_MS <= r[4] < T]
    out["m_buyers_5m"] = float(len({r[0] for r in crowd}))
    out["m_buysol_5m"] = float(sum(r[2] for r in crowd))

    # ---- regime, clock, social
    aw = case.get("active_wallets_1h")
    out["tracked_active_wallets_1h"] = num(aw)
    hour = (t % DAY_MS) / 3_600_000.0
    out["hour_sin"] = math.sin(2 * math.pi * hour / 24)
    out["hour_cos"] = math.cos(2 * math.pi * hour / 24)
    soc = db.get("social_scores")
    live = db.get("social_model_version")
    if soc and live and soc.get("model_version") == live and msec(soc.get("updated_at")) is not None \
            and t - msec(soc["updated_at"]) <= SOCIAL_MAX_AGE and math.isfinite(num(soc.get("score"))):
        out["social_score"] = num(soc["score"]) * SOCIAL_SHRINK / (SOCIAL_SHRINK + out["leader_n_prior7"])
        out["social_missing"] = 0.0
    else:
        out["social_score"] = 0.0
        out["social_missing"] = 1.0
    return out


def gate(case: dict, raw: dict) -> str | None:
    """The first hard gate (features.yaml `gates`, in order) that fires, or None: the signal reaches the network."""
    sw = case["swap"]
    venue, _ = strip_venue(sw.get("venue"))
    price = num(sw.get("price_sol"))
    if not num(sw.get("sol_amount")) >= MIN_LEADER_BUY_SOL:
        return "below_min_leader_buy"
    if msec(case["now"]) - msec(sw["ts"]) > MAX_COPY_DELAY_SEC * 1000:
        return "too_late"
    if venue is not None and venue.startswith("pumpswap") and price >= HIPRICE_SOL:
        return "pumpswap_hiprice"
    age = raw.get("mint_first_seen_age_min", NAN)
    if venue in YOUNG_AMM_VENUES and not (age >= YOUNG_AMM_MIN):
        return "young_amm"
    sc = case.get("screen")
    if sc and (sc.get("failed") or (sc.get("lp_locked_pct") is not None and num(sc["lp_locked_pct"]) <= SCREEN_LP_MIN_PCT)):
        return "screen_dead"
    return None


def entry_vector(case: dict, categories: dict[str, list[str]], norm: spec.Norm) -> tuple[dict, str | None, np.ndarray]:
    """(raw values, gate, normalised vector) of one case: what the runtime computes before asking the network."""
    raw = entry_raw(case)
    X = spec.encode(raw, spec.entry_features(), categories)
    return raw, gate(case, raw), spec.normalise(X, norm)[0]
