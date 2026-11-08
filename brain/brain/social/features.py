"""
The social model's inputs (brain/spec/features.yaml, `social.inputs`), computed for one wallet at one time t.

Point in time: only rows known before t count. A link counts once first_seen < t, a profile snapshot once fetched < t, a
post once ts < t AND fetched < t, a first buy once it was stored (known_at) before t, a copy outcome once resolved_at < t.

The same computation runs on the server in agent/src/social/score.ts; golden.json (golden.py) holds cases both sides
must reproduce to 1e-6. Change one side, change the other, and regenerate the golden file.

Owner-grade links (features.yaml `social.link_rule`): bio / tweet / timing links, or a mention by an author linked to at
most 3 wallets. The wallet's account is the owner-grade account with the most followers (latest snapshot before t; none
counts as -1, ties go to the lowest id). Account-level inputs and n_posts come from that account.

Choices the spec leaves open, made the same way on both sides:
  - follower_growth_7d uses ln((now + 1) / (then + 1)) so an account at 0 followers stays finite;
  - post_rate_7d counts deleted posts as 0 (a falling tweet count is not a negative rate);
  - mentioned_by_callers_30d counts the authors (not owner-grade linked to the wallet) whose posts carry the wallet's
    address: the caller panel and @-mentions are not collected yet; it is never missing (no posts = 0);
  - funder_cluster_size needs wallets.funder_filled_at; without it the input is missing everywhere, so the model never
    learns from a funder count the server could not have known.
"""
from __future__ import annotations

import bisect
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

DAY = 86_400.0
WINDOW_30D = 30 * DAY
WINDOW_7D = 7 * DAY
PAIR_WINDOW = DAY  # a post and the wallet's first buy of its coin pair up within +-24 h
MIN_PAIRS = 3  # buy_before_call_share_30d and median_call_lag_min are missing with fewer pairs
TRACKER_WALLETS = 3  # an author linked to more wallets than this is a tracker: its mentions are not owner-grade
OWNER_HOW = ("bio", "tweet", "timing")
SHRINK_N = 18.0  # n* of the social target and of own_record_shrunk (features.yaml social.target)

SPEC_PATH = Path(__file__).resolve().parents[2] / "spec" / "features.yaml"

# What each input needs from the spec; checked against features.yaml by the tests so the two can't drift apart.
TRANSFORMS = {
    "acct_age_days": "log1p",
    "followers_log": "none",
    "follower_growth_7d": "clip:-3,3",
    "post_rate_7d": "log1p",
    "ca_share_30d": "share",
    "buy_before_call_share_30d": "share",
    "median_call_lag_min": "signed_log",
    "engagement_med_30d": "none",
    "mentioned_by_callers_30d": "log1p",
    "wallets_per_account": "log1p",
    "accounts_per_wallet": "log1p",
    "funder_cluster_size": "log1p",
    "own_record_shrunk": "none",
}


@dataclass(frozen=True)
class InputSpec:
    name: str
    transform: str
    missing_flag: bool
    default: float | str  # a raw value, or "train_mean"


def load_spec(path: Path = SPEC_PATH) -> tuple[int, list[InputSpec]]:
    """(feature spec version, the social inputs in spec order)."""
    doc = yaml.safe_load(path.read_text())
    inputs = [
        InputSpec(i["name"], str(i.get("transform", "none")), bool(i.get("missing_flag", False)), i.get("default", 0.0))
        for i in doc["social"]["inputs"]
    ]
    return int(doc["version"]), inputs


def feature_names(spec: list[InputSpec]) -> list[str]:
    """The model's input columns: each input, followed by `<name>_missing` when the spec gives it a flag."""
    out: list[str] = []
    for s in spec:
        out.append(s.name)
        if s.missing_flag:
            out.append(f"{s.name}_missing")
    return out


def transform(kind: str, v: float) -> float:
    if kind in ("none", "share"):
        return float(v)
    if kind == "log1p":
        return math.log1p(max(float(v), 0.0))
    if kind == "signed_log":
        return math.copysign(math.log1p(abs(v)), v)
    if kind.startswith("clip:"):
        lo, hi = (float(x) for x in kind[5:].split(","))
        return min(max(float(v), lo), hi)
    raise ValueError(f"unknown transform {kind}")


def median(xs: list[float]) -> float:
    """The middle value, or the mean of the two middle ones (numpy's median; score.ts does the same)."""
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


# ---------------------------------------------------------------------------------------------------------------------
# The tables, indexed for lookups at many (wallet, t)


@dataclass
class SocialTables:
    """The private tables as frames, times in unix seconds (float). See data.py for where each comes from.

    links:      wallet, author_id, how, first_seen
    accounts:   id, created_at
    snapshots:  account_id, fetched, followers, tweets
    posts:      post_id, author_id, ts, fetched, likes, reposts, replies, quotes, mints (list), wallets (list)
    first_buys: wallet, mint, ts, known_at  (each wallet's first buy of each coin, and when the server had stored it)
    ledger:     leader, y, resolved_at      (copy outcomes: own_record_shrunk and, in train.py, the target)
    funders:    address, funder, first_seen, funder_filled  (None when wallets has no funder_filled_at)
    """

    links: pd.DataFrame
    accounts: pd.DataFrame
    snapshots: pd.DataFrame
    posts: pd.DataFrame
    first_buys: pd.DataFrame
    ledger: pd.DataFrame
    funders: pd.DataFrame | None = None


@dataclass
class Index:
    links_by_wallet: dict = field(default_factory=lambda: defaultdict(list))  # wallet -> [(author, how, first_seen)]
    links_by_author: dict = field(default_factory=lambda: defaultdict(list))  # author -> [(wallet, first_seen)]
    created: dict = field(default_factory=dict)  # account -> created_at
    snaps: dict = field(default_factory=dict)  # account -> (fetched[], followers[], tweets[]) sorted by fetched
    posts_by_author: dict = field(default_factory=lambda: defaultdict(list))  # author -> [(ts, fetched, eng, n_mints, mints)]
    mentions_by_wallet: dict = field(default_factory=lambda: defaultdict(list))  # wallet -> [(author, ts, fetched)]
    first_buy: dict = field(default_factory=dict)  # (wallet, mint) -> (ts, known_at)
    ledger: dict = field(default_factory=dict)  # leader -> (resolved_at[], y[]) sorted by resolved_at
    funder_of: dict = field(default_factory=dict)  # address -> (funder, funder_filled)
    by_funder: dict = field(default_factory=lambda: defaultdict(list))  # funder -> [(first_seen, funder_filled)]
    has_funders: bool = False


def _num(v) -> float | None:
    return None if v is None or pd.isna(v) else float(v)


def build_index(t: SocialTables) -> Index:
    ix = Index()
    for w, a, how, fs in t.links[["wallet", "author_id", "how", "first_seen"]].itertuples(index=False):
        ix.links_by_wallet[w].append((a, how, float(fs)))
        ix.links_by_author[a].append((w, float(fs)))
    for a, c in t.accounts[["id", "created_at"]].itertuples(index=False):
        ix.created[a] = _num(c)
    for a, g in t.snapshots.sort_values(["account_id", "fetched"]).groupby("account_id", sort=False):
        ix.snaps[a] = (g.fetched.astype(float).tolist(), [_num(v) for v in g.followers], [_num(v) for v in g.tweets])
    posts = t.posts.sort_values("ts")
    for r in posts.itertuples(index=False):
        eng = sum(_num(getattr(r, k)) or 0.0 for k in ("likes", "reposts", "replies", "quotes"))
        mints = list(r.mints) if r.mints is not None else []
        ix.posts_by_author[r.author_id].append((float(r.ts), float(r.fetched), eng, mints))
        for w in set(r.wallets if r.wallets is not None else []):
            ix.mentions_by_wallet[w].append((r.author_id, float(r.ts), float(r.fetched)))
    for w, m, ts, k in t.first_buys[["wallet", "mint", "ts", "known_at"]].itertuples(index=False):
        ix.first_buy[(w, m)] = (float(ts), float(k))
    for lead, g in t.ledger.dropna(subset=["y"]).sort_values("resolved_at").groupby("leader", sort=False):
        ix.ledger[lead] = (g.resolved_at.astype(float).to_numpy(), g.y.astype(float).to_numpy())
    if t.funders is not None:
        ix.has_funders = True
        for a, f, fs, ff in t.funders[["address", "funder", "first_seen", "funder_filled"]].itertuples(index=False):
            if f is None or pd.isna(f):
                continue
            ff = _num(ff)
            ix.funder_of[a] = (f, ff)
            ix.by_funder[f].append((_num(fs), ff))
    return ix


# ---------------------------------------------------------------------------------------------------------------------
# One wallet at one time


def owner_accounts(ix: Index, wallet: str, t: float) -> list[str]:
    """The wallet's owner-grade accounts at t, sorted."""
    out = set()
    for a, how, fs in ix.links_by_wallet.get(wallet, ()):
        if fs >= t:
            continue
        if how in OWNER_HOW:
            out.add(a)
        elif how == "mention" and len({w for w, fs2 in ix.links_by_author[a] if fs2 < t}) <= TRACKER_WALLETS:
            out.add(a)
    return sorted(out)


def _snapshot_at(ix: Index, account: str, t: float) -> int:
    """Index of the latest snapshot fetched before t, or -1."""
    s = ix.snaps.get(account)
    return bisect.bisect_left(s[0], t) - 1 if s else -1


def primary_account(ix: Index, accounts: list[str], t: float) -> str | None:
    best, best_f = None, None
    for a in accounts:  # sorted: the first of equals wins
        i = _snapshot_at(ix, a, t)
        f = ix.snaps[a][1][i] if i >= 0 else None
        f = -1.0 if f is None else f
        if best is None or f > best_f:
            best, best_f = a, f
    return best


def raw_inputs(ix: Index, wallet: str, t: float, pop_mean: float) -> tuple[dict[str, float | None], int] | None:
    """The raw (untransformed) inputs of `wallet` at t, None = missing, and n_posts. None when it has no owner-grade link."""
    owners = owner_accounts(ix, wallet, t)
    if not owners:
        return None
    acct = primary_account(ix, owners, t)
    v: dict[str, float | None] = {}

    # profile: the latest snapshot before t, and the newest one at least 7 days older than it
    i = _snapshot_at(ix, acct, t)
    created = ix.created.get(acct)
    v["acct_age_days"] = max(0.0, (t - created) / DAY) if i >= 0 and created is not None else None
    v["followers_log"] = v["follower_growth_7d"] = v["post_rate_7d"] = None
    if i >= 0:
        fetched, followers, tweets = ix.snaps[acct]
        if followers[i] is not None:
            v["followers_log"] = math.log1p(max(followers[i], 0.0))
        j = bisect.bisect_right(fetched, fetched[i] - WINDOW_7D) - 1
        if j >= 0:
            if followers[i] is not None and followers[j] is not None:
                v["follower_growth_7d"] = math.log((max(followers[i], 0.0) + 1) / (max(followers[j], 0.0) + 1))
            if tweets[i] is not None and tweets[j] is not None:
                v["post_rate_7d"] = max(0.0, tweets[i] - tweets[j]) / ((fetched[i] - fetched[j]) / DAY)

    # the account's posts in [t - 30 d, t), read before t
    posts = [p for p in ix.posts_by_author.get(acct, ()) if t - WINDOW_30D <= p[0] < t and p[1] < t]
    v["ca_share_30d"] = sum(1 for p in posts if p[3]) / len(posts) if posts else None
    engaged = [math.log1p(p[2]) for p in posts if p[1] - p[0] >= DAY]
    v["engagement_med_30d"] = median(engaged) if engaged else None
    lags = []
    for ts, _, _, mints in posts:
        for m in mints:
            b = ix.first_buy.get((wallet, m))
            if b and b[0] < t and b[1] < t and abs(ts - b[0]) <= PAIR_WINDOW:
                lags.append((ts - b[0]) / 60.0)
    enough = len(lags) >= MIN_PAIRS
    v["buy_before_call_share_30d"] = sum(1 for x in lags if x > 0) / len(lags) if enough else None
    v["median_call_lag_min"] = median(lags) if enough else None

    owner_set = set(owners)
    v["mentioned_by_callers_30d"] = float(len({a for a, ts, f in ix.mentions_by_wallet.get(wallet, ())
                                               if t - WINDOW_30D <= ts < t and f < t and a not in owner_set}))
    v["wallets_per_account"] = float(len({w for w, fs in ix.links_by_author[acct] if fs < t}))
    v["accounts_per_wallet"] = float(len({a for a, _, fs in ix.links_by_wallet[wallet] if fs < t}))

    v["funder_cluster_size"] = None
    if ix.has_funders:
        f, filled = ix.funder_of.get(wallet, (None, None))
        if f is not None and filled is not None and filled < t:
            v["funder_cluster_size"] = float(sum(1 for fs, ff in ix.by_funder[f]
                                                 if fs is not None and fs < t and ff is not None and ff < t))

    led = ix.ledger.get(wallet)
    s, n = 0.0, 0
    if led is not None:
        lo, hi = np.searchsorted(led[0], t - WINDOW_7D, "left"), np.searchsorted(led[0], t, "left")
        s, n = float(led[1][lo:hi].sum()), int(hi - lo)
    v["own_record_shrunk"] = (s + SHRINK_N * pop_mean) / (n + SHRINK_N)
    return v, len(posts)


def transformed(spec: list[InputSpec], raw: dict[str, float | None]) -> dict[str, float | None]:
    """Each input after its spec transform; None stays None (missing)."""
    return {s.name: None if raw[s.name] is None else transform(s.transform, raw[s.name]) for s in spec}


def fill_values(spec: list[InputSpec], rows: list[dict[str, float | None]]) -> dict[str, float]:
    """The (transformed) value a missing input takes: its training mean for `train_mean`, else its transformed default."""
    out = {}
    for s in spec:
        if s.default == "train_mean":
            vals = [r[s.name] for r in rows if r[s.name] is not None]
            out[s.name] = float(np.mean(vals)) if vals else 0.0
        else:
            out[s.name] = transform(s.transform, float(s.default))
    return out


def vector(spec: list[InputSpec], x: dict[str, float | None], fill: dict[str, float]) -> list[float]:
    """The model's input row (before normalisation), in feature_names(spec) order."""
    out: list[float] = []
    for s in spec:
        miss = x[s.name] is None
        out.append(fill[s.name] if miss else x[s.name])
        if s.missing_flag:
            out.append(1.0 if miss else 0.0)
    return out
