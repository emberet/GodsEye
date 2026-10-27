//! ge-ingest: reads every DEX transaction from the Yellowstone gRPC stream the agent uses (GRPC_URL / GRPC_TOKEN /
//! STREAM_PROGRAMS), parses swaps with ge-parse, and writes one JSON event per transaction to every client of a unix
//! socket (GE_INGEST_SOCKET). Without gRPC credentials it replays a fixture file (GE_INGEST_REPLAY) instead.
//! It never signs or sends a transaction, holds no keys, and never logs GRPC_TOKEN.

use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ge_ingest::event::event_line;
use ge_ingest::info_from_proto;
use ge_ingest::metrics::Metrics;
use ge_ingest::pb::geyser::{
    geyser_client::GeyserClient, subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing,
};
use ge_parse::convert::GrpcTxInfo;
use ge_parse::fixture::FixtureTx;
use ge_parse::programs::STREAM_DEFAULT_PROGRAMS;
use ge_parse::{convert_grpc_tx, swaps_for_update, ParseOptions};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::broadcast;

type Line = Arc<str>;

struct Config {
    grpc_url: String,
    grpc_token: String,
    programs: Vec<String>,
    socket: String,
    metrics_addr: String,
    replay: Option<String>,
    replay_rate: f64,
    replay_loop: bool,
    replay_wait_client: bool,
    buffer: usize,
}

fn env(name: &str) -> String {
    std::env::var(name)
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

impl Config {
    fn from_env() -> Config {
        let list = |n: &str| {
            env(n)
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        };
        let programs = list("STREAM_PROGRAMS");
        Config {
            grpc_url: env("GRPC_URL"),
            grpc_token: env("GRPC_TOKEN"),
            programs: if programs.is_empty() {
                STREAM_DEFAULT_PROGRAMS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            } else {
                programs
            },
            socket: Some(env("GE_INGEST_SOCKET"))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/tmp/godseye-ingest.sock".into()),
            metrics_addr: Some(env("GE_INGEST_METRICS_ADDR"))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "127.0.0.1:9466".into()),
            replay: Some(env("GE_INGEST_REPLAY")).filter(|s| !s.is_empty()),
            replay_rate: env("GE_INGEST_REPLAY_RATE").parse().unwrap_or(0.0),
            replay_loop: env("GE_INGEST_REPLAY_LOOP") == "1",
            replay_wait_client: env("GE_INGEST_REPLAY_NO_WAIT") != "1",
            buffer: env("GE_INGEST_BUFFER").parse().unwrap_or(65_536),
        }
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn log(level: &str, msg: &str) {
    eprintln!("{} [{level}] {msg}", ge_parse::jsnum::iso_from_ms(now_ms()));
}

/// Parse one update and fan it out. Returns false when it couldn't be converted.
fn emit(
    info: &GrpcTxInfo,
    slot: u64,
    received_at_ms: f64,
    lag_ms: Option<i64>,
    out: &broadcast::Sender<Line>,
    m: &Metrics,
) {
    m.tx_total.fetch_add(1, Relaxed);
    m.last_slot.store(slot, Relaxed);
    if let Some(l) = lag_ms {
        m.observe_lag(l);
    }
    let Some(conv) = convert_grpc_tx(info, slot, received_at_ms) else {
        return;
    };
    let swaps = swaps_for_update(&conv, &ParseOptions::default());
    m.swaps_total.fetch_add(swaps.len() as u64, Relaxed);
    let line: Line = event_line(&conv, &swaps, received_at_ms, lag_ms).into();
    m.events_total.fetch_add(1, Relaxed);
    let _ = out.send(line); // no clients = nothing to do
}

async fn serve_socket(
    path: String,
    out: broadcast::Sender<Line>,
    m: Arc<Metrics>,
) -> std::io::Result<()> {
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    log("info", &format!("socket listening on {path}"));
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut rx = out.subscribe();
        let m = m.clone();
        m.clients.fetch_add(1, Relaxed);
        tokio::spawn(async move {
            let (mut rd, mut wr) = stream.split();
            let mut sink = [0u8; 256];
            loop {
                tokio::select! {
                    r = rx.recv() => match r {
                        Ok(line) => {
                            if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() { break; }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => { m.dropped_events_total.fetch_add(n, Relaxed); }
                        Err(broadcast::error::RecvError::Closed) => break,
                    },
                    r = rd.read(&mut sink) => if matches!(r, Ok(0) | Err(_)) { break },
                }
            }
            m.clients.fetch_sub(1, Relaxed);
        });
    }
}

async fn serve_metrics(addr: String, m: Arc<Metrics>) -> std::io::Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    log("info", &format!("metrics on http://{addr}/metrics"));
    loop {
        let (mut s, _) = listener.accept().await?;
        let m = m.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = if req.starts_with("GET /metrics") || req.starts_with("GET / ") {
                ("200 OK", m.render())
            } else if req.starts_with("GET /healthz") {
                ("200 OK", "ok\n".to_string())
            } else {
                ("404 Not Found", "not found\n".to_string())
            };
            let resp = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; version=0.0.4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = s.write_all(resp.as_bytes()).await;
        });
    }
}

async fn replay(
    cfg: &Config,
    path: &str,
    out: &broadcast::Sender<Line>,
    m: &Metrics,
) -> std::io::Result<()> {
    if cfg.replay_wait_client {
        log(
            "info",
            "replay: waiting for a socket client (GE_INGEST_REPLAY_NO_WAIT=1 to skip)",
        );
        while m.clients.load(Relaxed) == 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    m.connected.store(1, Relaxed);
    loop {
        let f = tokio::fs::File::open(path).await?;
        let mut lines = BufReader::new(f).lines();
        let started = std::time::Instant::now();
        let mut n = 0u64;
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() {
                continue;
            }
            match FixtureTx::parse_line(&line).and_then(|fx| fx.to_grpc().map(|g| (fx, g))) {
                Ok((fx, info)) => emit(&info, fx.slot, fx.received_at_ms, None, out, m),
                Err(e) => {
                    m.parse_errors_total.fetch_add(1, Relaxed);
                    log("warn", &format!("replay: bad line: {e}"));
                }
            }
            n += 1;
            if cfg.replay_rate > 0.0 {
                let due = Duration::from_secs_f64(n as f64 / cfg.replay_rate);
                if let Some(wait) = due.checked_sub(started.elapsed()) {
                    tokio::time::sleep(wait).await;
                }
            } else if n.is_multiple_of(256) {
                tokio::task::yield_now().await;
            }
        }
        log("info", &format!("replay: {n} transactions sent"));
        if !cfg.replay_loop {
            // Let clients drain before exiting.
            tokio::time::sleep(Duration::from_millis(500)).await;
            m.connected.store(0, Relaxed);
            return Ok(());
        }
    }
}

fn request(programs: &[String], ping: Option<i32>) -> SubscribeRequest {
    let mut transactions = HashMap::new();
    transactions.insert(
        "dex".to_string(),
        SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            signature: None,
            account_include: programs.to_vec(),
            account_exclude: vec![],
            account_required: vec![],
        },
    );
    SubscribeRequest {
        transactions,
        commitment: Some(CommitmentLevel::Confirmed as i32),
        ping: ping.map(|id| SubscribeRequestPing { id }),
        ..Default::default()
    }
}

fn redact(text: &str, token: &str) -> String {
    let t = if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "***")
    };
    t.chars().take(240).collect()
}

#[allow(clippy::result_large_err)] // tonic interceptors must return Result<_, tonic::Status>
async fn grpc_once(
    cfg: &Config,
    out: &broadcast::Sender<Line>,
    m: &Metrics,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tonic::transport::{ClientTlsConfig, Endpoint};
    let mut ep = Endpoint::from_shared(cfg.grpc_url.clone())?
        .http2_keep_alive_interval(Duration::from_secs(15))
        .keep_alive_timeout(Duration::from_secs(10))
        .keep_alive_while_idle(true)
        .connect_timeout(Duration::from_secs(15));
    if cfg.grpc_url.starts_with("https") {
        ep = ep.tls_config(ClientTlsConfig::new().with_native_roots())?;
    }
    let channel = ep.connect().await?;
    let token: Option<tonic::metadata::AsciiMetadataValue> = if cfg.grpc_token.is_empty() {
        None
    } else {
        Some(cfg.grpc_token.parse()?)
    };
    let mut client = GeyserClient::with_interceptor(channel, move |mut req: tonic::Request<()>| {
        if let Some(t) = &token {
            req.metadata_mut().insert("x-token", t.clone());
        }
        Ok(req)
    })
    .max_decoding_message_size(64 * 1024 * 1024);
    let (req_tx, req_rx) = tokio::sync::mpsc::channel::<SubscribeRequest>(16);
    req_tx.send(request(&cfg.programs, None)).await?;
    let mut stream = client
        .subscribe(tokio_stream::wrappers::ReceiverStream::new(req_rx))
        .await?
        .into_inner();
    let host = cfg
        .grpc_url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split('/')
        .next()
        .unwrap_or("");
    log(
        "info",
        &format!(
            "gRPC connected ({host}): watching {} programs",
            cfg.programs.len()
        ),
    );
    m.connected.store(1, Relaxed);
    let programs = cfg.programs.clone();
    let pinger = tokio::spawn(async move {
        let mut id = 0;
        let mut iv = tokio::time::interval(Duration::from_secs(10));
        iv.tick().await;
        loop {
            iv.tick().await;
            id += 1;
            // Every write replaces the subscription, so the filter goes with the ping (as stream.ts does).
            if req_tx.send(request(&programs, Some(id))).await.is_err() {
                break;
            }
        }
    });
    let result = loop {
        match stream.message().await {
            Ok(Some(u)) => {
                if let Some(UpdateOneof::Transaction(t)) = u.update_oneof {
                    let Some(info) = t.transaction.as_ref() else {
                        continue;
                    };
                    let now = now_ms();
                    let lag = u
                        .created_at
                        .map(|c| now as i64 - (c.seconds * 1000 + i64::from(c.nanos) / 1_000_000));
                    emit(&info_from_proto(info), t.slot, now, lag, out, m);
                }
            }
            Ok(None) => break Ok(()),
            Err(e) => break Err(e.into()),
        }
    };
    pinger.abort();
    m.connected.store(0, Relaxed);
    result
}

async fn grpc_loop(cfg: &Config, out: &broadcast::Sender<Line>, m: &Metrics) {
    let ip_retry_ms: u64 = env("STREAM_IP_RETRY_MS").parse().unwrap_or(10_000);
    let mut backoff = 1_000u64;
    loop {
        match grpc_once(cfg, out, m).await {
            Ok(()) => {
                log("warn", "gRPC stream ended; reconnecting");
                backoff = 1_000;
            }
            Err(e) => {
                let msg = redact(&format!("{e:?}"), &cfg.grpc_token);
                let ip_rejected = msg.contains("not whitelisted");
                log("warn", &format!("gRPC error: {msg}"));
                let wait = if ip_rejected { ip_retry_ms } else { backoff };
                backoff = if ip_rejected {
                    1_000
                } else {
                    (backoff * 2).min(60_000)
                };
                m.reconnects_total.fetch_add(1, Relaxed);
                tokio::time::sleep(Duration::from_millis(wait)).await;
                continue;
            }
        }
        m.reconnects_total.fetch_add(1, Relaxed);
        tokio::time::sleep(Duration::from_millis(backoff)).await;
    }
}

#[tokio::main]
async fn main() {
    let cfg = Config::from_env();
    let metrics = Arc::new(Metrics::default());
    let (out, _) = broadcast::channel::<Line>(cfg.buffer.max(16));

    let sock = cfg.socket.clone();
    {
        let (out, m) = (out.clone(), metrics.clone());
        let sock = sock.clone();
        tokio::spawn(async move {
            if let Err(e) = serve_socket(sock, out, m).await {
                log("error", &format!("socket: {e}"));
                std::process::exit(1);
            }
        });
    }
    {
        let (addr, m) = (cfg.metrics_addr.clone(), metrics.clone());
        tokio::spawn(async move {
            if let Err(e) = serve_metrics(addr, m).await {
                log("error", &format!("metrics: {e}"));
                std::process::exit(1);
            }
        });
    }

    let run = async {
        if let Some(path) = cfg.replay.clone() {
            log("info", &format!("replay mode: {path}"));
            if let Err(e) = replay(&cfg, &path, &out, &metrics).await {
                log("error", &format!("replay: {e}"));
                std::process::exit(1);
            }
        } else if !cfg.grpc_url.is_empty() {
            grpc_loop(&cfg, &out, &metrics).await;
        } else {
            log("error", "no GRPC_URL set: set GRPC_URL (and GRPC_TOKEN) for live mode, or GE_INGEST_REPLAY=<fixtures.ndjson> to replay a file");
            std::process::exit(2);
        }
    };
    tokio::select! {
        _ = run => {}
        _ = tokio::signal::ctrl_c() => log("info", "stopping"),
    }
    let _ = std::fs::remove_file(&sock);
}
