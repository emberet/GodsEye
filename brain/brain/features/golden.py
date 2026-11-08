"""
spec/golden/entry.json and exit.json: input -> expected cases both the trainer (entry.py, exit.py) and the server
(agent/src/brain/features.ts) must reproduce to 1e-6. `python -m brain.features.golden` rewrites them from the hand-made
cases below; the Python tests check the files are up to date and reproduce them. spec/golden/README.md describes the
format.

Every name, address and number is made up. The norm and the venue_group levels are fixed here (not a trained model's),
so the files only change when the spec does: they carry their own `categories` and `norm`.
"""
from __future__ import annotations

import copy
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from brain.features import exit as fx
from brain.features import spec
from brain.features.entry import entry_vector

GOLDEN_DIR = Path(__file__).resolve().parents[2] / "spec" / "golden"
T = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)  # the leader's block time in every entry case
LEADER, OTHER1, OTHER2, OTHER3 = "GoldLeaderAAAA", "GoldWalletBBBB", "GoldWalletCCCC", "GoldWalletDDDD"
MINT = "GoldMintAAAApump"
CREATOR = "GoldCreatorAAAA"
CATEGORIES = {"venue_group": ["pumpswap", "pumpfun_curve", "meteora_damm_v2", "jupiter", "raydium", "missing", "other"]}


def at(seconds: float = 0.0) -> datetime:
    return T + timedelta(seconds=seconds)


def iso(seconds: float = 0.0) -> str:
    """T plus an offset as the server writes times (ISO, ms, Z)."""
    d = at(seconds)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def ms(seconds: float = 0.0) -> int:
    """T plus an offset as epoch ms (in-memory state)."""
    return int(round(at(seconds).timestamp() * 1000))


H, D = 3_600.0, 86_400.0


def synthetic_norm(cols: list[str], binary: set[str]) -> spec.Norm:
    """Fixed, made-up means and stds (not a model's): each column a different affine map."""
    mean = np.array([0.0 if c in binary else round(0.13 * (i % 7) - 0.3, 2) for i, c in enumerate(cols)])
    std = np.array([1.0 if c in binary else round(0.5 + 0.25 * (i % 5), 2) for i, c in enumerate(cols)])
    return spec.Norm(cols, mean, std)


# ---------------------------------------------------------------------------------------------------------------------
# Entry cases


def ring_swap(wallet, side, sol, price, ts_s, at_s=None, ok=True):
    return {"wallet": wallet, "side": side, "sol": sol, "price": price, "ts": ms(ts_s), "at": ms(ts_s + 0.4 if at_s is None else at_s), "ok": ok}


def scan_row(mint, side, sol, ts_s):
    return {"mint": mint, "side": side, "sol_amount": sol, "ts": iso(ts_s)}


def base_case() -> dict:
    """A known leader buying a pumpswap coin first seen 2 h ago, with history, ledgers and a crowd."""
    return {
        "now": iso(0.8),
        "swap": {"wallet": LEADER, "mint": MINT, "side": "buy", "sol_amount": 0.5, "price_sol": 4.2e-8, "token_amount": 11_904_761.9,
                 "token_balance_before": 0.0, "venue": "pumpswap", "fee_lamports": 120_000, "ts": iso(0), "signature": "GoldSig0001"},
        "ring": [
            ring_swap(OTHER1, "buy", 0.3, 3.9e-8, -240), ring_swap(OTHER2, "buy", 0.2, 4.0e-8, -100),
            ring_swap(OTHER2, "buy", 0.1, 4.05e-8, -50), ring_swap(OTHER3, "sell", 0.4, 4.1e-8, -30),
            ring_swap(LEADER, "buy", 0.2, 4.0e-8, -20), ring_swap(OTHER1, "buy", 0.05, 9.9e-6, -10, ok=False),
            ring_swap(OTHER3, "buy", 0.2, 3.0e-8, -1_800),
        ],
        "hist_max": {"price": 6.0e-8, "ts": ms(-5_400), "at": ms(-5_399)},
        "first_seen": {"firstSeenAt": ms(-7_200), "firstOkPrice": 2.0e-8, "firstOkAt": ms(-7_190), "creator": CREATOR,
                       "creatorResolvedAt": ms(-7_000)},
        "leader_holding": {"buyTs": ms(0), "postBuyTokens": 11_904_761.9, "soldTokens": 0.0},
        "active_wallets_1h": 2_400,
        "screen": None,
        "db": {
            "wallet_swaps": [
                scan_row("GoldMintBBBB", "buy", 0.3, -2 * D), scan_row("GoldMintBBBB", "sell", 0.31, -2 * D + 400),
                scan_row("GoldMintCCCCpump", "buy", 1.0, -3 * H), scan_row("GoldMintCCCCpump", "buy", 0.06, -2 * H),
                scan_row("GoldMintCCCCpump", "sell", 1.1, -1 * H), scan_row("GoldMintDDDD", "buy", 0.2, -5 * D),
                scan_row("GoldMintDDDD", "sell", 0.25, -5 * D + 30),
            ],
            "token_info": {"pool_created_at": iso(-3 * H), "launch_checked_at": iso(-2 * H)},
            "creator_coins": [{"mint": "GoldMintEEEEpump", "first_seen_at": iso(-3 * D)}, {"mint": "GoldMintFFFFpump", "first_seen_at": iso(-10 * D)}],
            "social_scores": None,
            "social_model_version": None,
        },
        "ledgers": {
            "mirror": [{"resolved_at": iso(-1 * D), "y": 0.12, "lr": math.log(1.12)}, {"resolved_at": iso(-2 * D), "y": -0.45, "lr": math.log(0.55)},
                       {"resolved_at": iso(-3 * D), "y": -1.0, "lr": math.log(0.01)}],
            "ps": [{"avail_at": iso(-1 * D), "r": 0.3, "done": 1}, {"avail_at": iso(-2 * D), "r": -1.0, "done": 1}],
            "dd": [{"avail_at": iso(-1 * D), "dead": 1, "done": 1}, {"avail_at": iso(-2 * D), "dead": 0, "done": 1},
                   {"avail_at": iso(-4 * D), "dead": 1, "done": 1}],
        },
    }


def entry_cases() -> list[tuple[str, str, dict]]:
    out = []

    def case(name: str, note: str, edit=None):
        c = base_case()
        if edit:
            edit(c)
        out.append((name, note, c))

    case("typical_copy", "known leader with history, ledgers, a 5-min crowd and a coin first seen 2 h ago: passes every gate")

    def bot(c):
        c["swap"]["venue"] = "pumpfun (via bot)"
        rows = []
        for i in range(12):  # a flipper: buys and sells the same coins within seconds
            ts = -6 * H + i * 600
            rows += [scan_row(f"GoldBotMint{i % 4}pump", "buy", 0.5, ts), scan_row(f"GoldBotMint{i % 4}pump", "sell", 0.5, ts + 8)]
        c["db"]["wallet_swaps"] = rows
        c["ledgers"] = {"mirror": [{"resolved_at": iso(-H * (k + 1)), "y": -0.3, "lr": math.log(0.7)} for k in range(6)], "ps": [], "dd": []}
    case("bot_leader_flipper", "bot leader flipping 4 coins every 10 min: b_first_7d 1/3, lf_flip60_7d 1, bad mirror record", bot)

    def bot_sold(c):
        c["swap"]["venue"] = "pumpfun (via bot)"
        c["leader_holding"]["soldTokens"] = 0.4 * 11_904_761.9
    case("bot_leader_sold_before_decision", "the leader sold 40 % of its post-buy position before the decision", bot_sold)

    def oversold(c):
        c["leader_holding"]["soldTokens"] = 2 * 11_904_761.9
    case("leader_sold_more_than_held", "sold more than the post-buy position: capped at 1", oversold)

    def unknown_holding(c):
        c["leader_holding"] = {"buyTs": ms(0), "postBuyTokens": None, "soldTokens": 5.0}
    case("leader_holding_unknown", "the stream gave no token balance: leader_sold_at_decision 0", unknown_holding)

    def first_sight(c):
        c["swap"]["venue"] = "pumpfun"
        c["first_seen"] = None
        c["ring"] = []
        c["hist_max"] = None
    case("first_sighting_unknown_coin", "the coin was never seen: age, first price and creator count are missing (pumpfun: no young_amm gate)", first_sight)

    def first_sight_this(c):
        c["swap"]["venue"] = "pumpfun"
        c["first_seen"] = {"firstSeenAt": ms(0.6), "firstOkPrice": 4.2e-8, "firstOkAt": ms(0.6), "creator": None, "creatorResolvedAt": None}
        c["ring"] = []
        c["hist_max"] = None
    case("first_sighting_by_this_swap", "the state recorded the coin when this swap arrived (first_seen_at >= T): missing like no sighting", first_sight_this)

    def first_sight_amm(c):
        c["first_seen"] = None
        c["ring"] = []
        c["hist_max"] = None
    case("first_sighting_pumpswap_gated", "pumpswap coin never seen before: young_amm", first_sight_amm)

    def young(c):
        c["first_seen"]["firstSeenAt"] = ms(-300)
        c["first_seen"]["firstOkAt"] = ms(-290)
    case("young_amm_gate", "pumpswap coin first seen 5 min ago: young_amm", young)

    def young_edge(c):
        c["first_seen"]["firstSeenAt"] = ms(0.8 - 600)
    case("young_amm_boundary_passes", "first seen exactly 10 min before t: age 10, not young", young_edge)

    def young_raydium(c):
        c["swap"]["venue"] = "raydium launchlab (via bot)"
        c["first_seen"]["firstSeenAt"] = ms(-120)
    case("young_raydium_launchlab_via_bot", "raydium launchlab (via bot), first seen 2 min ago: young_amm", young_raydium)

    def young_damm(c):
        c["swap"]["venue"] = "meteora damm v2"
        c["first_seen"]["firstSeenAt"] = ms(-120)
    case("young_meteora_damm_v2_passes", "meteora damm v2 is not in the young_amm venue list: passes", young_damm)

    def young_dbc(c):
        c["swap"]["venue"] = "meteora dbc"
        c["first_seen"]["firstSeenAt"] = ms(-60)
    case("young_meteora_dbc_gated", "meteora dbc first seen 1 min ago: young_amm; venue_group meteora_other is unseen -> other", young_dbc)

    def hiprice(c):
        c["swap"]["price_sol"] = 2.0e-4
    case("pumpswap_hiprice_gate", "pumpswap at 2e-4 SOL per token: pumpswap_hiprice", hiprice)

    def hiprice_edge(c):
        c["swap"]["venue"] = "pumpswap (via bot)"
        c["swap"]["price_sol"] = 9.9e-5
    case("pumpswap_just_below_hiprice", "pumpswap (via bot) at 9.9e-5: not gated", hiprice_edge)

    def small(c):
        c["swap"]["sol_amount"] = 0.15
    case("below_min_leader_buy", "a 0.15 SOL buy: below_min_leader_buy (it wins over every later gate)", small)

    def late(c):
        c["now"] = iso(75)
    case("too_late", "decided 75 s after the block time: too_late; signal_lateness_sec 75", late)

    def screen_fail(c):
        c["screen"] = {"failed": True, "lp_locked_pct": None}
    case("screen_failed", "the rug screen failed before t: screen_dead", screen_fail)

    def screen_lp(c):
        c["screen"] = {"failed": False, "lp_locked_pct": 0.5}
    case("screen_lp_unlocked", "lp_locked_pct 0.5 %: screen_dead", screen_lp)

    def screen_ok(c):
        c["screen"] = {"failed": False, "lp_locked_pct": 97.0}
    case("screen_passed", "the screen returned and passed: no gate", screen_ok)

    def no_venue(c):
        c["swap"]["venue"] = None
    case("venue_missing", "no venue on the swap: venue_group 'missing'", no_venue)

    def orca(c):
        c["swap"]["venue"] = "orca (via bot)"
        c["first_seen"]["firstSeenAt"] = ms(-3 * H)
    case("unseen_venue_orca_via_bot", "orca is not a trained level: venue_group=other; via bot", orca)

    def jup(c):
        c["swap"]["venue"] = "jupiter (via bot)"
    case("jupiter_via_bot", "aggregator-routed buy: venue_group jupiter", jup)

    def odd(c):
        c["swap"]["venue"] = "memefun"
    case("unknown_venue_string", "a venue no rule names: other", odd)

    def no_ledger(c):
        c["ledgers"] = {"mirror": [], "ps": [], "dd": []}
    case("no_ledger_rows", "a leader with no resolved copies: cp_n 0, cp_win / ps / dd missing", no_ledger)

    def ledger_edges(c):
        t = 0.8
        c["ledgers"] = {
            "mirror": [{"resolved_at": iso(t - 7 * D), "y": 0.5, "lr": math.log(1.5)},  # exactly t - 7 d: in
                       {"resolved_at": iso(t), "y": 3.0, "lr": math.log(4.0)},  # exactly t: out
                       {"resolved_at": iso(-H), "y": None, "lr": None},  # no entry: out
                       {"resolved_at": iso(-H), "y": 25.0, "lr": math.log(11.0)},  # clipped at 10 in lr
                       {"resolved_at": iso(t - 7 * D - 0.001), "y": 1.0, "lr": math.log(2.0)}],  # just too old
            "ps": [{"avail_at": iso(-H), "r": None, "done": 1}, {"avail_at": iso(-H), "r": 0.8, "done": 0},
                   {"avail_at": iso(-2 * H), "r": 0.25, "done": 1}],
            "dd": [{"avail_at": iso(-H), "dead": None, "done": 0}],
        }
    case("ledger_window_edges", "rows at t - 7 d count, at t not; null y / r, unfinished jobs and older rows are left out", ledger_edges)

    def scan_edges(c):
        c["db"]["wallet_swaps"] = [
            scan_row("GoldMintE1", "buy", 0.5, -7 * D),  # exactly T - 7 d: in
            scan_row("GoldMintE2", "buy", 0.5, -7 * D - 1),  # just too old
            scan_row("GoldMintE3", "buy", 0.5, 0),  # same block second as T: out
            scan_row("GoldMintE4", "buy", 0.04, -H),  # under 0.05 SOL: ignored
            scan_row("GoldMintE5", "buy", 0.1, -24 * H),  # exactly 24 h: in b_n_24h
            scan_row("GoldMintE6", "buy", 0.2, -60),  # T - 60 s: not settled for the flip share
            scan_row("GoldMintE6", "sell", 0.2, -30),
            scan_row("GoldMintE7", "buy", 0.3, -3 * H), scan_row("GoldMintE7", "sell", 0.3, -3 * H + 60),  # sold at +60 s: a flip
            scan_row("GoldMintE7", "buy", 0.06, -2 * H), scan_row("GoldMintE7", "sell", 0.3, -2 * H + 61),  # +61 s: not
        ]
    case("leader_scan_window_edges", "the wallet_swaps scan: [T - 7 d, T), 0.05 SOL floor, 24 h edge, flips within 60 s of settled buys", scan_edges)

    def no_scan(c):
        c["db"]["wallet_swaps"] = []
    case("leader_no_history", "nothing stored for the leader in 7 d: style shares missing, counts 0 (social shrink by 18/18)", no_scan)

    def zero_price(c):
        c["swap"]["price_sol"] = 0.0
    case("price_missing", "price_sol 0: log_mcap_sol, ret_since_first, dd_from_high missing", zero_price)

    def no_fee(c):
        c["swap"]["fee_lamports"] = None
    case("fee_missing", "no fee_lamports on the swap: log_fee missing", no_fee)

    def neg_fee(c):
        c["swap"]["fee_lamports"] = -1
    case("fee_negative", "fee_lamports -1 (the parser's 'unknown'): log_fee missing", neg_fee)

    def not_pump(c):
        c["swap"]["mint"] = "GoldMintZZZZ"
    case("mint_not_pump", "a mint address that does not end in 'pump' (70 % of episodes): sfx_pump 0", not_pump)

    def clock_behind(c):
        c["now"] = iso(-0.3)
    case("clock_behind_block_time", "the server clock reads 0.3 s before the block time: signal_lateness_sec floored at 0", clock_behind)

    def ring_edges(c):
        c["ring"] = [
            ring_swap(OTHER1, "buy", 0.3, 4e-8, -300),  # exactly T - 5 min: in
            ring_swap(OTHER2, "buy", 0.3, 4e-8, -300.001),  # just before: out
            ring_swap(OTHER3, "buy", 0.3, 4e-8, 0),  # T itself: out
            ring_swap(OTHER3, "buy", 0.7, 4e-8, -5, at_s=0.9),  # delivered after t: out
            ring_swap(OTHER1, "buy", 0.2, 4e-8, -100),  # same wallet twice: one buyer
            ring_swap(LEADER, "buy", 5.0, 4e-8, -50),  # the leader: out
            ring_swap(OTHER2, "buy", 0.9, 4e-7, -40, ok=False),  # not ok: out
            ring_swap(OTHER2, "sell", 0.9, 4e-8, -30),  # a sell: out
        ]
        c["hist_max"] = None
    case("ring_window_edges", "the 5-min crowd: [T - 5 min, T), delivered before t, ok buys by others, distinct wallets", ring_edges)

    def highs(c):
        c["ring"] = [ring_swap(OTHER1, "buy", 0.3, 9e-8, -59), ring_swap(OTHER2, "buy", 0.3, 5e-8, -61),
                     ring_swap(OTHER2, "buy", 0.3, 9.5e-8, -300, ok=False)]
        c["hist_max"] = {"price": 4.5e-8, "ts": ms(-6 * D), "at": ms(-6 * D)}
    case("high_ignores_last_minute", "dd_from_high: the 9e-8 print 59 s ago and a rejected print are ignored; max 5e-8", highs)

    def late_high(c):
        c["ring"] = [ring_swap(OTHER1, "buy", 0.3, 5e-8, -200), ring_swap(OTHER2, "buy", 0.3, 7e-8, -120, at_s=-30),
                     ring_swap(OTHER3, "buy", 0.3, 8e-8, -61, at_s=0.9)]
        c["hist_max"] = {"price": 6.5e-8, "ts": ms(-2 * D), "at": ms(-1 * H)}
    case("high_window_is_on_block_time", "dd_from_high windows on ts: a print from 120 s before T delivered 30 s before T counts "
         "(7e-8); one delivered after t does not; the stored high's ts decides its window, not when it arrived", late_high)

    def old_high(c):
        c["ring"] = []
        c["hist_max"] = {"price": 9e-7, "ts": ms(-8 * D), "at": ms(-8 * D)}
    case("high_older_than_7d", "the stored high is 8 days old: dd_from_high missing", old_high)

    def no_creator(c):
        c["first_seen"]["creator"] = None
    case("creator_not_resolved", "creator lookup pending: cr_seen_prior_7d missing", no_creator)

    def none_creator(c):
        c["first_seen"]["creator"] = ""
    case("creator_resolved_to_none", "creator looked up, none found: missing", none_creator)

    def creator_edges(c):
        c["db"]["creator_coins"] = [
            {"mint": "GoldMintC1pump", "first_seen_at": iso(0.8 - 7 * D)},  # exactly t - 7 d: in
            {"mint": "GoldMintC2pump", "first_seen_at": iso(0.8)},  # exactly t: out
            {"mint": MINT, "first_seen_at": iso(-2 * H)},  # this coin: out
            {"mint": "GoldMintC3pump", "first_seen_at": iso(-H)},
            {"mint": "GoldMintC4pump", "first_seen_at": iso(-30 * D)},
        ]
    case("creator_window_edges", "other coins of the creator first seen in [t - 7 d, t), this coin excluded", creator_edges)

    def serial(c):
        c["swap"]["venue"] = "pumpfun"
        c["db"]["creator_coins"] = [{"mint": f"GoldSerial{i}pump", "first_seen_at": iso(-H * (i + 1))} for i in range(14)]
    case("serial_creator", "a creator with 14 coins in the week", serial)

    def no_cache(c):
        c["db"]["token_info"] = {"pool_created_at": iso(-3 * H), "launch_checked_at": iso(5)}
    case("token_age_not_cached_yet", "launch time looked up after t: log_token_age missing", no_cache)

    def no_ti(c):
        c["db"]["token_info"] = None
    case("token_info_missing", "no token_info row: missing", no_ti)

    def future_pool(c):
        c["db"]["token_info"] = {"pool_created_at": iso(30), "launch_checked_at": iso(-10)}
    case("pool_created_after_block", "pool time after T (clock skew): age floored at 0", future_pool)

    def no_aw(c):
        c["active_wallets_1h"] = None
    case("active_wallets_missing", "no process saw the previous hour: tracked_active_wallets_1h takes the training mean", no_aw)

    def few_aw(c):
        c["active_wallets_1h"] = 0
    case("active_wallets_zero", "an empty hour: log10 floored at 1 wallet", few_aw)

    def social(c):
        c["db"]["social_scores"] = {"score": 0.04, "model_version": "soc-1", "updated_at": iso(-2 * H)}
        c["db"]["social_model_version"] = "soc-1"
    case("social_live", "a fresh social score of the live model, shrunk by 18 / (18 + leader_n_prior7)", social)

    def social_stale(c):
        c["db"]["social_scores"] = {"score": 0.04, "model_version": "soc-1", "updated_at": iso(-49 * H)}
        c["db"]["social_model_version"] = "soc-1"
    case("social_stale", "updated 49 h before t: 0 and social_missing 1", social_stale)

    def social_old_model(c):
        c["db"]["social_scores"] = {"score": 0.04, "model_version": "soc-0", "updated_at": iso(-H)}
        c["db"]["social_model_version"] = "soc-1"
    case("social_other_model", "scored by an older social model: missing", social_old_model)

    def old_coin(c):
        c["first_seen"]["firstSeenAt"] = ms(-10 * D)
        c["first_seen"]["firstOkAt"] = ms(-10 * D)
        c["first_seen"]["firstOkPrice"] = 1e-11
    case("old_coin_age_capped", "first seen 10 days ago: age capped at 10,080 min; ret_since_first above the clip (raw kept)", old_coin)

    def late_first_price(c):
        c["first_seen"]["firstOkPrice"] = 4.0e-8
        c["first_seen"]["firstOkAt"] = ms(0.5)
    case("first_ok_price_from_this_second", "the first ok price came from this block second: ret_since_first missing, age present", late_first_price)

    def midnight(c):
        c["now"] = (T.replace(hour=23, minute=59, second=59) + timedelta(milliseconds=500)).strftime("%Y-%m-%dT%H:%M:%S.") + "500Z"
        c["swap"]["ts"] = T.replace(hour=23, minute=59, second=59).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    case("clock_before_midnight", "t = 23:59:59.5 UTC: hour features near 24", midnight)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Exit cases


def base_exit() -> dict:
    return {
        "now": iso(600),
        "position": {"leader": LEADER, "mint": MINT, "tokens": 2_000_000.0, "tokens_left": 2_000_000.0, "venue": "pumpfun"},
        "state": {"ret_now": 0.18, "peak_ret": 0.35, "minutes_held": 9.9, "leader_sold": False, "half_sold": False,
                  "minutes_since_price": 0.3, "quote_failed": False, "mins_since_tracked_price": 0.3, "sell_quote_ratio": 0.97,
                  "ret_5m_ago": 0.25, "leader_sold_frac": 0.0, "minutes_since_leader_sold": 0.0},
        "ring": [ring_swap(OTHER1, "buy", 0.3, 5e-8, 400), ring_swap(OTHER2, "sell", 0.5, 5.1e-8, 500), ring_swap(LEADER, "buy", 1.0, 5e-8, 550),
                 ring_swap(OTHER3, "buy", 0.2, 6e-6, 560, ok=False)],
        "active_wallets_1h": 1_800,
        "leader_ps_r_7d": 0.12,
    }


def exit_cases() -> list[tuple[str, str, dict]]:
    out = []

    def case(name: str, note: str, edit=None):
        c = base_exit()
        if edit:
            edit(c)
        out.append((name, note, c))

    case("holding_in_profit", "10 min in, +18 % off a +35 % peak, fresh prices, a small crowd")

    def leader_out(c):
        c["state"].update({"leader_sold": True, "leader_sold_frac": 0.6, "minutes_since_leader_sold": 4.5})
    case("leader_sold_part", "the leader sold 60 % 4.5 min ago", leader_out)

    def dead(c):
        c["state"].update({"ret_now": -0.99, "peak_ret": 0.1, "quote_failed": True, "minutes_since_price": 45.0,
                           "mins_since_tracked_price": 2_000.0, "sell_quote_ratio": None})
        c["ring"] = []
    case("dead_coin_no_route", "no route: quote_failed, near -100 %, tracked price 2000 min old (capped 1440), no quote ratio", dead)

    def half(c):
        c["position"]["tokens_left"] = 1_000_000.0
        c["state"]["half_sold"] = True
    case("after_sell_half", "half sold: position 0.5", half)

    def ps_venue(c):
        c["position"]["venue"] = "pumpswap (via bot)"
    case("pumpswap_entry", "entered on pumpswap (via bot)", ps_venue)

    def spike(c):
        c["state"].update({"ret_now": 24.0, "peak_ret": 31.0, "ret_5m_ago": 1.5})
    case("moonshot_clipped", "+2400 % off a +3100 % peak: ret and peak clip at 20", spike)

    def missing(c):
        c["active_wallets_1h"] = None
        c["leader_ps_r_7d"] = None
        c["state"]["leader_sold_frac"] = None
    case("carried_values_missing", "no hourly count, no ps_r_7d at entry, unknown leader holding", missing)

    def floor(c):
        c["state"].update({"ret_now": -1.0, "ret_5m_ago": -1.0, "peak_ret": -1.0})
    case("written_down_to_zero", "ret -100 % now and 5 min ago: mom5 0 (log floor), drawdown 0 when 1 + peak <= 0", floor)

    def edges(c):
        c["ring"] = [ring_swap(OTHER1, "buy", 0.3, 5e-8, 300), ring_swap(OTHER2, "buy", 0.3, 5e-8, 299.999),
                     ring_swap(OTHER3, "sell", 0.4, 5e-8, 600), ring_swap(OTHER3, "sell", 0.4, 5e-8, 590, at_s=601),
                     ring_swap(OTHER1, "sell", 1.0, 5e-8, 450), ring_swap(LEADER, "sell", 2.0, 5e-8, 470)]
    case("flow_window_edges", "[t - 5 min, t) delivered before t; the leader counts only in pts_5m", edges)

    def no_tokens(c):
        c["position"]["tokens"] = 0.0
        c["position"]["tokens_left"] = 0.0
    case("zero_tokens", "a position with no tokens recorded: position 1", no_tokens)

    def young(c):
        c["now"] = iso(45)
        c["state"].update({"ret_now": -0.05, "peak_ret": 0.0, "minutes_held": 0.7, "ret_5m_ago": 0.0, "sell_quote_ratio": 1.6})
        c["ring"] = []
    case("just_entered", "45 s in: mom5 against the entry", young)
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Trailing price filter cases (the ring's `ok` flags)


def px(wallet, price, sol=0.2, tokens=None):
    return {"wallet": wallet, "price": price, "sol": sol, "tokens": sol / price if tokens is None and price > 0 else (tokens or 0.0)}


def filter_cases() -> list[tuple[str, str, list[dict]]]:
    A, B, C, D = LEADER, OTHER1, OTHER2, OTHER3
    crowd = [A, B, C, D]
    out = []
    out.append(("steady", "small moves by several wallets: all ok, the first price is ok with no history",
                [px(crowd[i % 4], 1e-7 * (1 + 0.05 * (i % 3))) for i in range(12)]))
    out.append(("unit_glitch", "one print 30x off the market by another wallet: rejected; the market around it stays ok",
                [px(crowd[i % 4], 1e-7) for i in range(6)] + [px(B, 3e-6)] + [px(crowd[i % 4], 1.1e-7) for i in range(4)]))
    out.append(("rug_heals_on_the_7th_print", "a real lasting 100x drop: the 7th print at the new level is ok (6 of the previous 10 "
                "valid prices are low), and so is everything after",
                [px(crowd[i % 4], 1e-6) for i in range(10)] + [px(crowd[i % 4], 1e-8) for i in range(9)]))
    out.append(("pump_heals_on_the_6th_print", "a lasting 50x rise heals sooner: with 5 old and 5 new prices the median is their "
                "mean, within 10x of the new level",
                [px(crowd[i % 4], 1e-8) for i in range(10)] + [px(crowd[(i + 1) % 4], 5e-7) for i in range(8)]))
    out.append(("invalid_rows_skip_the_window", "price 0, dust SOL, < 1 token, NaN-free but negative price: never ok and never in the window",
                [px(A, 1e-7), px(B, 0.0, 0.2, 5.0), px(C, 1e-7, 0.0005), px(D, 50.0, 0.2, 0.004), px(B, -1e-7, 0.2, 5.0),
                 px(C, 1.05e-7), px(D, 2e-6)]))
    out.append(("first_valid_price_is_ok_whatever_it_is", "invalid rows first, then an extreme first valid price: ok (no history)",
                [px(A, 0.0, 0.2, 1.0), px(B, 1e-7, 0.0001), px(C, 5.0, 3.0, 1.0), px(D, 4.0, 3.0, 1.0)]))
    out.append(("ten_x_is_inclusive", "exactly 1/10 and exactly 10x of the median pass (and count as near another wallet's "
                "print); just beyond fails",
                [px(B, 1.0, 1.0, 1.0), px(C, 1.0, 1.0, 1.0), px(D, 0.1, 1.0, 10.0), px(B, 10.0, 10.0, 1.0), px(C, 10.000001, 10.0, 1.0)]))
    out.append(("even_window_median", "four previous prices: the median is the mean of the middle two (1.5 and 2.5 -> 2.0), so 20.0 "
                "is exactly 10x; the next median is 2.5",
                [px(B, 1.0, 1.0, 1.0), px(C, 1.5, 1.0, 1.0), px(D, 2.5, 1.0, 1.0), px(B, 3.0, 1.0, 1.0), px(C, 20.0, 20.0, 1.0),
                 px(D, 20.0001, 20.0, 1.0)]))
    out.append(("lone_wallet_run", "one wallet prints 30x above everyone: lone (no other wallet near it) and rejected until its own "
                "prints fill the whole window, then ok because no other wallet's print is left to contradict it",
                [px(crowd[1 + i % 3], 1e-7) for i in range(10)] + [px(A, 3e-6) for _ in range(12)]))
    out.append(("lone_broken_by_a_second_wallet", "a second wallet joining the new level makes it not lone: from then on both pass "
                "once the median moves",
                [px(crowd[1 + i % 3], 1e-7) for i in range(10)] + [px(A, 3e-6), px(B, 3e-6), px(A, 3e-6), px(B, 3e-6), px(A, 3e-6),
                                                                    px(B, 3e-6), px(A, 3e-6)]))
    out.append(("within_range_but_lone", "within 10x of the median, but every other wallet's recent print is more than 10x away: lone",
                [px(B, 1e-7), px(C, 1e-7), px(A, 5e-7), px(A, 5e-7), px(A, 5e-7), px(A, 5e-7), px(A, 5e-7), px(A, 1.5e-6)]))
    out.append(("window_is_ten", "one early print by another wallet 100x above keeps the only active wallet's prints lone while it "
                "is among the previous 10 valid prices; the 11th print after it is ok",
                [px(B, 1e-5)] + [px(A, 1e-7) for _ in range(12)]))
    return out


def build_filter() -> dict:
    from brain.data import derive
    from brain.features import prices

    cases = [{"name": n, "note": note, "input": {"swaps": rows}, "expected": {"ok": prices.ok_flags(rows)}}
             for n, note, rows in filter_cases()]
    return {"feature_spec_version": spec.version(), "head": "filter", "window": derive.TRAIL_WINDOW, "outlier_x": derive.OUTLIER_X,
            "min_sol": derive.MIN_PRICE_SOL, "min_tokens": derive.MIN_PRICE_TOKENS, "cases": cases}


# ---------------------------------------------------------------------------------------------------------------------


def _clean(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, (np.floating,)):
        return _clean(float(v))
    return v


def build_entry() -> dict:
    feats = spec.entry_features()
    cols = spec.columns(feats, CATEGORIES)
    norm = synthetic_norm(cols, spec.binary_columns(feats, CATEGORIES))
    cases = []
    for name, note, c in entry_cases():
        raw, g, z = entry_vector(copy.deepcopy(c), CATEGORIES, norm)
        cases.append({"name": name, "note": note, "input": c,
                      "expected": {"gate": g, "raw": {k: _clean(raw[k]) for k in [f.name for f in feats]}, "vector": [float(x) for x in z]}})
    return {"feature_spec_version": spec.version(), "head": "entry", "features": [f.name for f in feats], "columns": cols,
            "categories": CATEGORIES, "norm": {"mean": norm.mean.tolist(), "std": norm.std.tolist()}, "cases": cases}


def build_exit() -> dict:
    feats = spec.exit_features()
    cols = spec.columns(feats)
    norm = synthetic_norm(cols, spec.binary_columns(feats))
    cases = []
    for name, note, c in exit_cases():
        inputs = fx.case_inputs(copy.deepcopy(c))
        raw = fx.exit_raw(inputs)
        z = spec.normalise(spec.encode(raw, feats), norm)[0]
        cases.append({"name": name, "note": note, "input": c,
                      "expected": {"raw": {k: _clean(raw[k]) for k in [f.name for f in feats]}, "vector": [float(x) for x in z]}})
    return {"feature_spec_version": spec.version(), "head": "exit", "features": [f.name for f in feats], "columns": cols,
            "categories": {}, "norm": {"mean": norm.mean.tolist(), "std": norm.std.tolist()}, "cases": cases}


def render(doc: dict) -> str:
    return json.dumps(doc, indent=1, allow_nan=False) + "\n"


def write(dest: Path = GOLDEN_DIR) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for name, doc in (("entry.json", build_entry()), ("exit.json", build_exit()), ("filter.json", build_filter())):
        p = dest / name
        p.write_text(render(doc))
        out.append(p)
    return out


if __name__ == "__main__":
    for p in write():
        print(p)
