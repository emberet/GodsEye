//! Counters served as Prometheus text on GE_INGEST_METRICS_ADDR (default 127.0.0.1:9466), path /metrics.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::Mutex;
use std::time::Instant;

/// Rate window for tx/s and swaps/s: (start, tx at start, swaps at start, last tx/s, last swaps/s).
type RateWindow = (Instant, u64, u64, f64, f64);

#[derive(Default)]
pub struct Metrics {
    pub tx_total: AtomicU64,
    pub swaps_total: AtomicU64,
    pub events_total: AtomicU64,
    pub parse_errors_total: AtomicU64,
    pub dropped_events_total: AtomicU64,
    pub reconnects_total: AtomicU64,
    pub clients: AtomicI64,
    pub connected: AtomicI64,
    pub last_slot: AtomicU64,
    /// Milliseconds between the provider stamping an update (created_at) and this service emitting it.
    pub lag_ms_last: AtomicI64,
    pub lag_ms_sum: AtomicU64,
    pub lag_samples: AtomicU64,
    window: Mutex<Option<RateWindow>>,
}

impl Metrics {
    pub fn observe_lag(&self, ms: i64) {
        self.lag_ms_last.store(ms, Relaxed);
        self.lag_ms_sum.fetch_add(ms.max(0) as u64, Relaxed);
        self.lag_samples.fetch_add(1, Relaxed);
    }

    /// tx/s and swaps/s over the time since the previous scrape (at least 1 s), else the last value.
    fn rates(&self) -> (f64, f64) {
        let now = Instant::now();
        let (tx, sw) = (self.tx_total.load(Relaxed), self.swaps_total.load(Relaxed));
        let mut w = self.window.lock().unwrap_or_else(|e| e.into_inner());
        let out = match *w {
            Some((t0, tx0, sw0, rtx, rsw)) => {
                let dt = now.duration_since(t0).as_secs_f64();
                if dt < 1.0 {
                    return (rtx, rsw);
                }
                ((tx - tx0) as f64 / dt, (sw - sw0) as f64 / dt)
            }
            None => (0.0, 0.0),
        };
        *w = Some((now, tx, sw, out.0, out.1));
        out
    }

    pub fn render(&self) -> String {
        let (txs, sws) = self.rates();
        let samples = self.lag_samples.load(Relaxed);
        let avg = if samples > 0 {
            self.lag_ms_sum.load(Relaxed) as f64 / samples as f64
        } else {
            0.0
        };
        let mut s = String::new();
        let mut line = |name: &str, kind: &str, help: &str, v: String| {
            s.push_str(&format!(
                "# HELP {name} {help}\n# TYPE {name} {kind}\n{name} {v}\n"
            ));
        };
        line(
            "ge_ingest_tx_total",
            "counter",
            "Transaction updates received.",
            self.tx_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_swaps_total",
            "counter",
            "Swaps parsed.",
            self.swaps_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_events_total",
            "counter",
            "Events written to the socket fan-out.",
            self.events_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_parse_errors_total",
            "counter",
            "Updates that could not be decoded or converted.",
            self.parse_errors_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_dropped_events_total",
            "counter",
            "Events a slow socket client missed.",
            self.dropped_events_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_reconnects_total",
            "counter",
            "gRPC reconnects.",
            self.reconnects_total.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_tx_per_sec",
            "gauge",
            "Transactions per second since the last scrape.",
            format!("{txs:.2}"),
        );
        line(
            "ge_ingest_swaps_per_sec",
            "gauge",
            "Swaps per second since the last scrape.",
            format!("{sws:.2}"),
        );
        line(
            "ge_ingest_lag_ms",
            "gauge",
            "Last update's lag: provider created_at to emit, ms.",
            self.lag_ms_last.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_lag_ms_avg",
            "gauge",
            "Average lag since start, ms.",
            format!("{avg:.1}"),
        );
        line(
            "ge_ingest_last_slot",
            "gauge",
            "Slot of the latest transaction.",
            self.last_slot.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_clients",
            "gauge",
            "Connected socket clients.",
            self.clients.load(Relaxed).to_string(),
        );
        line(
            "ge_ingest_connected",
            "gauge",
            "1 while the gRPC stream (or replay) is running.",
            self.connected.load(Relaxed).to_string(),
        );
        s
    }
}
