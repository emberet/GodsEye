# Brain contract: Mac trainer ↔ server runtime

The Python side (`brain/`, trained on the owner's Mac) and the TypeScript runtime (`agent/src/brain/`, on the server)
meet only through this contract. Change both sides and bump `FEATURE_SPEC_VERSION` together.

## Model bundle

The Mac pushes a directory to the server at `data/brain/staging/<version>/`, then the runtime (or the push script)
renames it into `data/brain/models/<version>/` and atomically points `data/brain/current` (a symlink) at it.
The previous version is kept for rollback.

`manifest.json`:

```json
{
  "version": "2026-11-07T12-00-00Z",
  "created_at": "2026-11-07T12:00:00Z",
  "feature_spec_version": 1,
  "entry": {
    "features": ["leader_n_prior", "..."],
    "norm": { "mean": [0.0], "std": [1.0] },
    "members": ["entry-0.onnx", "entry-1.onnx", "entry-2.onnx", "entry-3.onnx", "entry-4.onnx"],
    "input": "x",
    "output": "q",
    "actions": [0, 0.25, 0.5, 0.75, 1.0],
    "margin_c": 0.5,
    "categories": { "venue": ["pump", "pumpswap", "raydium", "other"] }
  },
  "exit": {
    "features": ["ret_now", "..."],
    "norm": { "mean": [0.0], "std": [1.0] },
    "file": "exit.onnx",
    "input": "x",
    "output": "q",
    "actions": ["hold", "sell_half", "sell_all"]
  },
  "brain_enabled": true,
  "explore": { "rate": 0.1, "curiosity": 0.5 },
  "metrics": { "validation": {}, "stress": {}, "baseline": {} },
  "sha256": { "entry-0.onnx": "…" }
}
```

- `entry` members are an ensemble. Each maps the normalised entry features (float32 `[n, F]`) to `q` (float32 `[n, 5]`): the
  expected reward of each action, where the action is the stake as a fraction of the real per-trade size
  (`COPY_MAX_TRADE_SOL`), 0 meaning skip, on any analyzed wallet whatever its copy weight. The runtime never stakes more
  than 1.0 × that size. (Baseline stakes what the real engine would: `copySize` of the wallet's copy weight.)
- **Hard gates first:** the `gates` in `features.yaml` are applied before any network; a gated signal is skipped by
  Brain and Explore (logged with `info.gate`).
- **Decision (Brain account):** for each action, score = mean `q` over members − `margin_c` × std `q` over members; pick
  the best non-zero action by score and copy only when its score > 0 (otherwise skip). With `brain_enabled: false` the
  Brain account skips every signal (the bundle is for exploration only).
- **Exploration (Explore account):** with probability `explore.rate` a signal is routed to the Explore account instead:
  Thompson sampling, i.e. one member chosen at random decides, plus `curiosity × std(q over members)` added to every
  non-zero action. Explore trades are recorded separately so they never count in the Brain account's results.
- `exit` maps normalised exit features to `q` over `hold / sell_half / sell_all`, evaluated for each open Brain/Explore
  position once a minute, on each stream price for that coin (at most every 15 s) and at once on the leader's sell.
  `sell_half` is allowed once.
- **Dead coins:** a coin with no stream price for 90 s is marked with a Jupiter sell quote; 3 failed quotes in a row (no
  route) mark it worthless: the position closes as a write-off at value 0 with the rent lost (`info.forced = "dead"`).
  Paper costs: `BRAIN_TX_COST_SOL` (0.0003) per transaction, `BRAIN_RENT_SOL` on a write-off.
- Hard safety stops always apply on top of the exit network: −60% stop-loss and a 24 h maximum hold.
- Missing feature values are passed as NaN-free numbers: the feature's training mean, plus a `<name>_missing` = 1 flag
  when the spec lists one.

## Promotion

`python -m brain.gate --bundle <dir>` exits 0 to promote (strict: beats the B4 hand-rule baseline per copy with a
mint-clustered CI above 0 on the selection window, a minimum copies per day, passes the stress suite, no worse drawdown).
Exit 3 = explore-only: the bundle passes the sanity and stress checks but not the bar; it is pushed with
`brain_enabled: false` only while the server has no promoted model, so Explore keeps gathering data. Exit 5 = real-test:
not promoted, but the bundle passes the sanity checks and the stress suite's safety checks scored on the server's
real-money rails (`brain/spec/rails.yaml`), with only the proven-edge and stress bars relaxed; it is pushed with
`brain_enabled: true, real_test: true` unless the server runs a promoted model. `real_test: true` is the runtime's
licence to let the Brain sleeve follow the model with real money (agent/src/brain/sleeve.ts); a promoted bundle carries
it too when its gate report passed the real-test check. Anything else: keep the server's current model.

## Features

The single source of truth is `brain/spec/features.yaml` (written by the research run): names, definitions, windows
and missing-value flags. Both `brain/brain/features/` (Python) and `agent/src/brain/features.ts` (TS) implement every
name, point-in-time (nothing after the decision time). `brain/spec/golden/*.json` holds input → expected vectors; both
test suites must reproduce them to 1e-6.

## Reward

Defined in `brain/spec/reward.yaml`: per trade, net SOL P&L after every fee and rent, losses weighted κ×, minus
λ × the increase in the account's drawdown. Used by the trainer only; the runtime just records outcomes.

## Transitions (server → Mac)

Table `brain_transitions` (append-only, integer `id`), one row per decision step:
`id, ts, account ('brain'|'explore'|'baseline'), kind ('entry'|'exit'), position_id, leader, mint, model_version,
features (JSON array), action, q (JSON), reward (null until known), done (0/1), info (JSON)`.
The Mac pulls it incrementally (`brain/brain/export/pull.py`).

Conventions (agent/src/brain/paper.ts, transitions.ts):
- an entry row's `action` is the stake fraction; `info.base_size_sol` is the size it is a fraction of, `info.blocked` says
  why a chosen entry didn't open (budget, cash, loss limit, below the minimum trade, no quote) with reward 0, done 1;
- an exit row's `action` is the index into `["hold","sell_half","sell_all"]`; forced exits (hard stop, max hold,
  write-off) are `sell_all` with `features: []` and `info.forced`; a second `sell_half` is logged as `hold` with
  `info.chosen = "sell_half"`;
- when a position closes, its entry row and its last exit row get the net SOL P&L as reward and done = 1; earlier exit
  rows keep reward null (the trainer assigns per-step rewards from the reward spec);
- Baseline's entries are logged too (`account = 'baseline'`), with the Brain's features for that signal or `[]`.

## Social score

Private. Pushed like the model bundle (`brain.push --social`): `data/brain/social/models/<version>/` with
`data/brain/social/current` pointing at the live one, holding `manifest.json` + `social.onnx` (same shape rules, single
output = predicted 14-day copy return). Resolve `current` once and read both files from that directory. The server
writes `social_scores(wallet, score, n_posts, model_version, updated_at)` hourly; the entry features read
`social_score` and `social_missing` from it. Nothing about social data is ever published (site, API, snapshot, logs).
