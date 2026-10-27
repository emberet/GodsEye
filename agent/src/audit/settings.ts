/**
 * Settings of the audit trail and the copyability gate. Read from the environment here (not in config.ts) so the audit
 * code stands on its own. The gate only LOGS what it would have decided: nothing here changes a copy.
 */
import { envBool, envNum } from "@godseye/shared";

export const auditSettings = {
  /** Record wallet evaluations and copy decisions. */
  auditEnabled: envBool("AUDIT_ENABLED", true),
  /** Quote every candidate buy at the size GodsEye would use and log how copyable it was (never blocks). */
  gateEnabled: envBool("GATE_LOG_ENABLED", true),
  /** Would-block limits. */
  gateMaxImpactPct: envNum("GATE_MAX_IMPACT_PCT", 3),
  gateMaxDriftPct: envNum("GATE_MAX_DRIFT_PCT", 15),
  /** The pool(s) a buy goes through must be able to take this many times its size back before the price falls gateExitDropPct (read from chain). */
  gateMinExitMultiple: envNum("GATE_MIN_EXIT_MULTIPLE", 3),
  gateExitDropPct: envNum("GATE_EXIT_DROP_PCT", 20),
  /** Largest round-trip loss (buy then sell at the same size, quoted now) the gate accepts, %. */
  gateMaxRoundTripLossPct: envNum("GATE_MAX_ROUND_TRIP_LOSS_PCT", 15),
  /** Worst-case network and priority fees as a share of the trade. */
  gateMaxFeePct: envNum("GATE_MAX_FEE_PCT", 5),
  /** Quotes in flight at once, how many may wait, and how often one token is quoted again. */
  gateConcurrency: envNum("GATE_CONCURRENCY", 1),
  gateMaxQueue: envNum("GATE_MAX_QUEUE", 30),
  gateMinGapSeconds: envNum("GATE_MIN_GAP_SECONDS", 300),
  /** At least this long between two gate quotes, and how long the gate stands down after Jupiter says "too many requests": it must never crowd out the real buy's quote. */
  gateMinSpacingMs: envNum("GATE_MIN_SPACING_MS", 1200),
  gateRateLimitPauseSeconds: envNum("GATE_RATE_LIMIT_PAUSE_SECONDS", 60),
  /** Give up on a quote after this long. */
  gateTimeoutMs: envNum("GATE_TIMEOUT_MS", 8000),
  /** An unchanged copied wallet is recorded again after this long. */
  evaluationHeartbeatHours: envNum("EVALUATION_HEARTBEAT_HOURS", 24),
};

export type AuditSettings = typeof auditSettings;
