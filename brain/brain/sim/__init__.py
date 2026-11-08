"""
brain.sim: the rebuilt paper-copy simulator (brain/spec/sim.yaml, CONTRACT.md) and its baselines' yardstick.

  model     agent/src/replay/model.ts line for line (buyFill / sellFill / midAt); golden-fixture parity to 1e-9
  params    SimParams (sim.yaml params) and Chaos (stress.yaml knobs); keyed random draws (common random numbers)
  quotes    the quote/mark model fit on pre-test shadow quotes (obs_ratio known at t; m_alive / f_dark hindsight)
  tape      SwapTape: the ok-filtered (trailing) tracked swap tape with vectorised per-mint lookups and insert time
  signals   leader buys from derived/episodes, the features.yaml gates, the leader's later sells
  engine    SimData / Book: the event-driven lockstep simulator (entries, decisions, forced exits, valuation)
  account   the 1 SOL / 5-slot paper account and every metric (per decision, per copy with mint CI, per day, drawdown)
  evaluate  load_window + evaluate(entry, exit): the batch evaluator
  env       BatchEnv / Env for the trainer, with the reward.yaml reward (kappa, potential-based exit shaping)
  stress    training chaos sampling and the named stress scenarios
  ledger    the mirror ledger (cp_* copy history) that B4's leader veto reads

Paper money only: nothing here reaches the real copy engine, signs a transaction or writes to the server.
"""
