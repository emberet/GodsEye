"""
golden.json: social-input cases both the trainer (features.py) and the server's scorer (agent/src/social/score.ts) must
reproduce to 1e-6. `python -m brain.social.golden` rewrites it from the hand-made tables below; the Python tests check
the file is up to date, and agent/test/social-score.test.ts loads the same tables into SQLite and compares.

The tables use the server's column names and formats (ISO times, JSON address arrays). Every name is made up.
Cases: W1 has a bio-linked account with history, posts, call pairs, copy outcomes (one coin bought twice: both ledger
rows count) and a funder group; W2's only links are a tracker's mention (not owner-grade) and an account with no profile
read; W3 has two owner accounts (the one with more followers is used) and mentions by other authors; W4's link is only
known after t; W5 has no link at all.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from brain.social.data import social_frames, to_sec
from brain.social.features import build_index, feature_names, load_spec, raw_inputs, transformed, vector

GOLDEN = Path(__file__).with_name("golden.json")
T = datetime(2026, 12, 1, tzinfo=timezone.utc)
POP_MEAN = -0.08


def iso(days: float = 0.0, hours: float = 0.0, minutes: float = 0.0) -> str:
    """t plus an offset, as the server writes times."""
    d = T + timedelta(days=days, hours=hours, minutes=minutes)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def tables() -> dict[str, list[dict]]:
    W1, W2, W3, W4, X1, X2, X3 = "GoldW1aaaa", "GoldW2bbbb", "GoldW3cccc", "GoldW4dddd", "GoldX1eeee", "GoldX2ffff", "GoldX3gggg"
    M = [f"GoldMint{i}pump" for i in range(6)]
    link = lambda w, a, how, fs: {"wallet": w, "author_id": a, "how": how, "n": 1, "first_seen_at": fs, "updated_at": fs}  # noqa: E731
    links = [
        link(W1, "a1", "bio", iso(-20)),
        link(X1, "a1", "mention", iso(-3)),  # a1 is linked to 2 wallets
        link(W2, "a2", "mention", iso(-10)),  # a2 posts 4 wallets: a tracker
        link(X1, "a2", "mention", iso(-10)), link(X2, "a2", "mention", iso(-9)), link(X3, "a2", "mention", iso(-8)),
        link(W2, "a3", "mention", iso(-5)),  # a3 posts only W2: owner-grade, but never read
        link(W3, "a4", "bio", iso(-15)),
        link(W3, "a5", "tweet", iso(-12)),
        link(W3, "a6", "timing", iso(1)),  # known after t: doesn't count
        link(W4, "a1", "bio", iso(2)),
    ]
    acct = lambda a, created: {"id": a, "username": f"golden_{a}", "created_at": created, "fetched_at": iso(-1)}  # noqa: E731
    accounts = [acct("a1", iso(-400)), acct("a2", iso(-50)), acct("a3", None), acct("a4", iso(-30)), acct("a5", iso(-1000)), acct("a6", iso(-5))]
    snap = lambda a, fetched, followers, tweets: {"account_id": a, "fetched_at": fetched, "followers": followers, "following": 10,  # noqa: E731
                                                  "tweets": tweets, "listed": 0, "verified": 0}
    snapshots = [
        snap("a1", iso(-20), 80, 480), snap("a1", iso(-10), 100, 500), snap("a1", iso(-2), 150, 540),
        snap("a1", iso(0, hours=1), 9999, 9999),  # read after t
        snap("a4", iso(-3), 500, 10),  # no snapshot 7 d older: growth and rate missing
        snap("a5", iso(-9), 1000, 2000), snap("a5", iso(-1), 900, 1990),  # fewer posts than before: rate 0
    ]
    post_n = iter(range(1000, 2000))

    def post(a, ts, fetched, mints=(), wallets=(), likes=None, reposts=None, replies=None, quotes=None):
        return {"post_id": str(next(post_n)), "author_id": a, "ts": ts, "text": "golden", "likes": likes, "reposts": reposts,
                "replies": replies, "quotes": quotes, "impressions": None, "mints": json.dumps(list(mints)),
                "wallets": json.dumps(list(wallets)), "fetched_at": fetched}

    posts = [
        post("a1", iso(-25), iso(-6), [M[0]], likes=10, reposts=2, replies=1, quotes=0),  # buy 30 min before
        post("a1", iso(-20), iso(-6), [M[1]], likes=4),  # buy 2 h after
        post("a1", iso(-15), iso(-6), [M[2]], likes=50, reposts=5),  # buy 10 min before
        post("a1", iso(-12), iso(-6), [M[3]]),  # buy 3 d before: no pair
        post("a1", iso(-10), iso(-6), [], likes=1),
        post("a1", iso(-0.5), iso(-0.4), [M[4]], likes=100),  # read 2.4 h after posting: no engagement; its buy is after t
        post("a1", iso(-31), iso(-6), [M[0]], likes=7),  # before the 30-day window
        post("a1", iso(-1), iso(0, hours=2), [M[5]], likes=3),  # read after t
        post("a4", iso(-4), iso(-3), [M[1]], [W3], likes=2),  # an owner of W3: not a caller
        post("a5", iso(-5), iso(-1), [M[0], M[1]], likes=0),
        post("a5", iso(-40), iso(-1), [M[2]]),
        post("a7", iso(-6), iso(-1), [], [W3]),
        post("a8", iso(-7), iso(-6), [], [W3, W1]),
        post("a8", iso(-8), iso(-6), [], [W3]),  # same author: counted once
        post("a9", iso(-35), iso(-6), [], [W3]),  # outside the window
        post("a9", iso(-2), iso(0, minutes=5), [], [W1]),  # read after t
    ]
    swap_n = iter(range(1, 1000))

    def buy(w, mint, ts):
        i = next(swap_n)
        return {"wallet": w, "signature": f"goldsig{i}", "slot": i, "ts": ts, "mint": mint, "side": "buy", "token_amount": 1000.0,
                "sol_amount": 0.5, "price_sol": 0.0005}

    swaps = [
        buy(W1, M[0], iso(-25, minutes=-30)), buy(W1, M[0], iso(-24)),  # the first buy counts
        buy(W1, M[1], iso(-20, hours=2)),
        buy(W1, M[2], iso(-15, minutes=-10)),
        buy(W1, M[3], iso(-15)),
        buy(W1, M[4], iso(0, minutes=10)),  # after t
        buy(W3, M[0], iso(-5, hours=-1)), buy(W3, M[1], iso(-5, hours=1)),
    ]
    sw = swaps + [dict(buy(W1, M[1], iso(-21)), side="sell")]  # a sell never pairs
    ledger_row = lambda w, mint, buy_d, y, res_d: {"leader": w, "mint": mint, "buy_ts": iso(buy_d), "y": y, "resolved_at": iso(res_d)}  # noqa: E731
    ledger = [
        ledger_row(W1, M[0], -6, 0.5, -5.9), ledger_row(W1, M[1], -4, -0.6, -3.5), ledger_row(W1, M[2], -1, 0.1, -0.5),
        ledger_row(W1, M[1], -3, 0.3, -2.5),  # a repeat buy of a coin: every ledger row counts, as the server reads them
        ledger_row(W1, M[3], -9, 2.0, -8),  # resolved before the 7-day window
        ledger_row(W1, M[4], -0.2, 1.0, 0.1),  # resolved after t
        ledger_row(W3, M[0], -2, -1.0, -1.5),
    ]
    wal = lambda a, fs, f, ff: {"address": a, "first_seen_at": fs, "funder": f, "funder_filled_at": ff}  # noqa: E731
    wallets = [
        wal(W1, iso(-60), "GoldFunder1", iso(-50)), wal(X1, iso(-40), "GoldFunder1", iso(-39)),
        wal(X2, iso(-40), "GoldFunder1", iso(1)),  # funder filled after t
        wal(X3, iso(1), "GoldFunder1", iso(1)),  # first seen after t
        wal(W2, iso(-60), "GoldFunder2", None), wal(W3, iso(-60), None, None), wal(W4, iso(-60), None, None),
    ]
    return {"social_wallet_accounts": links, "social_accounts": accounts, "social_account_snapshots": snapshots,
            "social_posts": posts, "wallet_swaps": sw, "mirror_ledger": ledger, "wallets": wallets}


def compute(tb: dict[str, list[dict]], t_iso: str, pop_mean: float, fill: list[float]) -> dict[str, dict | None]:
    """features.py on the golden tables: {wallet: {"vector", "n_posts"} or None}."""
    _, spec = load_spec()
    st = social_frames({k: pd.DataFrame(v) for k, v in tb.items()})
    sw = pd.DataFrame(tb["wallet_swaps"])
    sw = sw[sw.side == "buy"].assign(ts=lambda d: to_sec(d.ts)).sort_values("ts").drop_duplicates(["wallet", "mint"])
    st.first_buys = sw.assign(known_at=sw.ts)[["wallet", "mint", "ts", "known_at"]]  # live: stored when it happened
    led = pd.DataFrame(tb["mirror_ledger"])
    st.ledger = pd.DataFrame({"leader": led.leader, "y": led.y, "resolved_at": to_sec(led.resolved_at)})
    wl = pd.DataFrame(tb["wallets"])
    st.funders = pd.DataFrame({"address": wl.address, "funder": wl.funder, "first_seen": to_sec(wl.first_seen_at),
                               "funder_filled": to_sec(wl.funder_filled_at)})
    ix = build_index(st)
    t = float(to_sec(pd.Series([t_iso])).iloc[0])
    fills = {s.name: f for s, f in zip(spec, fill)}
    out: dict[str, dict | None] = {}
    for w in sorted({r["wallet"] for r in tb["social_wallet_accounts"]} | {r["address"] for r in tb["wallets"]} | {"GoldW5hhhh"}):
        r = raw_inputs(ix, w, t, pop_mean)
        out[w] = None if r is None else {"vector": vector(spec, transformed(spec, r[0]), fills), "n_posts": r[1]}
    return out


def build() -> dict:
    _, spec = load_spec()
    fill = [round(0.1 * (i + 1), 3) for i in range(len(spec))]  # arbitrary, so a wrong fill shows
    tb = tables()
    return {"t": iso(), "pop_mean": POP_MEAN, "features": feature_names(spec), "fill": fill, "tables": tb,
            "expected": compute(tb, iso(), POP_MEAN, fill)}


def main() -> None:
    GOLDEN.write_text(json.dumps(build(), indent=1) + "\n")
    print(f"wrote {GOLDEN}")


if __name__ == "__main__":
    main()
