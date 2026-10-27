use ge_flow::backtest::{self, Market, Params};
use ge_flow::flow::{analyse, FlowParams};
use ge_flow::synth::swap;
use std::collections::HashMap;

fn hand_params(slip: f64) -> Params {
    Params {
        delay_sec: 5.0,
        land_sec: 2.0,
        size_sol: 0.1,
        fee_bps: 100.0,
        slippage_bps: slip,
        tx_cost_sol: 0.0,
        fixed_depth_sol: Some(100.0),
        stop_loss_pct: 1e9,
        take_profit_pct: 1e9,
        ..Default::default()
    }
}

/// Leader buys 1 SOL at 1.01 (mid 1.00), sells everything at 1.98 (mid 2.00) 100 s later; depth 100 SOL.
/// By hand (see README "Phase 4"): our buy = 1.01 x 1.01 x (1 + 0.1/100) = 1.0211101 SOL/token,
/// sell mid = 2.00 / 1.02, proceeds = tokens x mid x 0.99 / (1 + value/100).
#[test]
fn backtest_matches_hand_computed_example() {
    let swaps = vec![
        swap("L", "M", 0, true, 1.0, 1.01, 0.0),
        swap("L", "M", 100_000, false, 2.0, 1.98, 1.0 / 1.01),
    ];
    for (slip, proceeds, ret) in [
        (0.0, 0.1897383188710794, 89.73831887107939),
        (50.0, 0.18785216658291462, 87.85216658291462),
    ] {
        let m = Market::new(&swaps);
        let r = backtest::backtest_leader(&m, "L", &["M"], &hand_params(slip));
        assert_eq!(r.n_trades, 1);
        assert!((r.copy_pnl_sol - (proceeds - 0.1)).abs() < 1e-12, "{r:?}");
        assert!((r.copy_return_pct.unwrap() - ret).abs() < 1e-9);
        // ideal = leader's own fills: 0.1/1.01 tokens sold at 1.98
        assert!((r.ideal_return_pct.unwrap() - (1.98 / 1.01 - 1.0) * 100.0).abs() < 1e-9);
    }
}

/// Price climbs for 2 minutes after the leader's buy (others piling in), then is flat until the leader sells.
fn pump_tape() -> Vec<ge_flow::Swap> {
    let mut v = vec![swap("L", "M", 0, true, 1.0, 1.0, 0.0)];
    let mut p = 1.0;
    for s in 1..=120 {
        p *= 1.01;
        v.push(swap("N", "M", s * 1000, true, 0.5, p, 0.0));
    }
    for s in (130..900).step_by(10) {
        v.push(swap("N", "M", s * 1000, s % 20 == 0, 0.01, p, 0.0));
    }
    v.push(swap("L", "M", 600_000, false, 3.0, p, 1.0));
    v
}

#[test]
fn delay_reduces_returns_monotonically() {
    let swaps = pump_tape();
    let m = Market::new(&swaps);
    let mut last = f64::INFINITY;
    for d in [0.0, 1.0, 5.0, 15.0, 30.0, 60.0, 120.0] {
        let r = backtest::backtest_leader(
            &m,
            "L",
            &["M"],
            &Params {
                delay_sec: d,
                ..hand_params(0.0)
            },
        );
        let ret = r.copy_return_pct.unwrap();
        assert!(ret < last, "delay {d}: {ret} !< {last}");
        last = ret;
    }
}

#[test]
fn slippage_reduces_returns_monotonically() {
    let swaps = ge_flow::synth::market(20, 10, 30, 9);
    let m = Market::new(&swaps);
    let names: Vec<String> = (0..20).map(|l| format!("L{l}")).collect();
    let mut last: Option<Vec<f64>> = None;
    for s in [0.0, 25.0, 100.0, 300.0, 1000.0] {
        let p = Params {
            slippage_bps: s,
            fixed_depth_sol: Some(50.0),
            ..Default::default()
        };
        let rs: Vec<f64> = backtest::backtest_all(&m, &names, &p, 4)
            .iter()
            .map(|r| r.copy_pnl_sol)
            .collect();
        if let Some(prev) = &last {
            for (a, b) in rs.iter().zip(prev) {
                assert!(a < b, "slippage {s}: {a} !< {b}");
            }
        }
        last = Some(rs);
    }
}

#[test]
fn parallel_equals_serial() {
    let swaps = ge_flow::synth::market(30, 8, 20, 3);
    let m = Market::new(&swaps);
    let names: Vec<String> = (0..30).map(|l| format!("L{l}")).collect();
    let p = Params::default();
    assert_eq!(
        backtest::backtest_all(&m, &names, &p, 1),
        backtest::backtest_all(&m, &names, &p, 7)
    );
}

#[test]
fn stop_loss_and_drawdown() {
    // price collapses right after our entry; leader never sells -> our stop-loss fires
    let mut v = vec![swap("L", "M", 0, true, 1.0, 1.0, 0.0)];
    for s in 1..300 {
        v.push(swap(
            "N",
            "M",
            s * 1000,
            false,
            0.2,
            1.0 * 0.98f64.powi(s as i32),
            0.0,
        ));
    }
    let m = Market::new(&v);
    let r = backtest::backtest_leader(
        &m,
        "L",
        &["M"],
        &Params {
            fixed_depth_sol: Some(100.0),
            ..Default::default()
        },
    );
    assert_eq!(r.n_trades, 1);
    assert!(
        r.copy_return_pct.unwrap() < -35.0 + 1e-9 && r.copy_return_pct.unwrap() > -80.0,
        "{r:?}"
    );
    assert!((r.max_drawdown_sol + r.copy_pnl_sol).abs() < 1e-12);
}

// ---- money flow ----

const S: i64 = 1000;

fn flow_world() -> (Vec<ge_flow::Swap>, HashMap<String, String>) {
    let mut v = Vec::new();
    // SKILLED trades its own coins early; nobody copies it, it copies nobody.
    for k in 0..20 {
        v.push(swap(
            "SKILLED",
            &format!("own{k}"),
            k * 3600 * S,
            true,
            1.0,
            1e-6,
            0.0,
        ));
    }
    // LEAD buys 10 coins; FOLLOW buys 8 of them 10-40 s later, plus 2 of its own.
    for k in 0..10 {
        let t = k * 3600 * S;
        v.push(swap("LEAD", &format!("hot{k}"), t, true, 1.0, 1e-6, 0.0));
        if k < 8 {
            v.push(swap(
                "FOLLOW",
                &format!("hot{k}"),
                t + (10 + 4 * k) * S,
                true,
                0.5,
                1e-6,
                0.0,
            ));
        }
    }
    v.push(swap("FOLLOW", "f0", 0, true, 0.5, 1e-6, 0.0));
    v.push(swap("FOLLOW", "f1", 0, true, 0.5, 1e-6, 0.0));
    // SYB_A/B/C buy the same coins in the same second (bundled) -> lockstep cluster
    for k in 0..6 {
        for w in ["SYB_A", "SYB_B", "SYB_C"] {
            v.push(swap(
                w,
                &format!("bundle{k}"),
                50 * 3600 * S + k * 600 * S,
                true,
                0.4,
                1e-6,
                0.0,
            ));
        }
    }
    // FUND_1/2/3 share a funder but trade unrelated coins
    for (i, w) in ["FUND_1", "FUND_2", "FUND_3"].iter().enumerate() {
        v.push(swap(w, &format!("solo{i}"), 0, true, 1.0, 1e-6, 0.0));
    }
    // 60 wallets funded by one exchange hot wallet, unrelated trading -> NOT a cluster
    let mut funders: HashMap<String, String> = ["FUND_1", "FUND_2", "FUND_3"]
        .iter()
        .map(|w| (w.to_string(), "FUNDER_X".to_string()))
        .collect();
    for i in 0..60 {
        let w = format!("RETAIL{i}");
        v.push(swap(&w, &format!("r{i}"), i * 7 * S, true, 0.3, 1e-6, 0.0));
        funders.insert(w, "EXCHANGE".into());
    }
    funders.insert("SKILLED".into(), "EXCHANGE".into());
    (v, funders)
}

#[test]
fn flow_detects_follower_sybil_funder_and_spares_independent() {
    let (v, f) = flow_world();
    let out = analyse(&v, &f, &FlowParams::default());
    let get = |w: &str| out.iter().find(|x| x.wallet == w).unwrap().clone();

    let fo = get("FOLLOW");
    assert_eq!(fo.role, "follower");
    assert_eq!(fo.follows.as_deref(), Some("LEAD"));
    assert!((fo.lead_lag_score - 0.8).abs() < 1e-12);
    assert!(fo.independent_score < 0.25);
    assert_eq!(get("LEAD").role, "leader");
    assert_eq!(get("LEAD").independent_score, 1.0);

    for w in ["SYB_A", "SYB_B", "SYB_C"] {
        let x = get(w);
        assert_eq!(x.role, "sybil");
        assert_eq!(x.cluster_id.as_deref(), Some("SYB_A"));
        assert_eq!(x.independent_score, 0.0);
    }
    for w in ["FUND_1", "FUND_2", "FUND_3"] {
        let x = get(w);
        assert_eq!(x.role, "sybil", "{x:?}");
        assert_eq!(x.cluster_id.as_deref(), Some("FUND_1"));
        assert_eq!(x.independent_score, 0.5);
    }
    let s = get("SKILLED");
    assert_eq!(
        (s.role, s.cluster_id.clone(), s.independent_score),
        ("independent", None, 1.0)
    );
    assert_eq!(get("RETAIL7").role, "independent");
}

#[test]
fn flow_coincidence_is_not_following() {
    // Two wallets that each bought the same 2 hot coins seconds apart: below min_events, no flag.
    let v = vec![
        swap("A", "x", 0, true, 1.0, 1.0, 0.0),
        swap("B", "x", 5 * S, true, 1.0, 1.0, 0.0),
        swap("A", "y", 0, true, 1.0, 1.0, 0.0),
        swap("B", "y", S, true, 1.0, 1.0, 0.0),
    ];
    let out = analyse(&v, &HashMap::new(), &FlowParams::default());
    assert!(out
        .iter()
        .all(|w| w.role == "independent" && w.cluster_id.is_none()));
}

#[test]
fn db_roundtrip_readonly_source() {
    let dir = std::env::temp_dir().join(format!("ge-flow-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.db");
    let _ = std::fs::remove_file(&path);
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch(
        "CREATE TABLE wallet_swaps (id INTEGER PRIMARY KEY, wallet TEXT, signature TEXT, slot INTEGER, ts TEXT, mint TEXT,
           side TEXT, token_amount REAL, token_balance_before REAL DEFAULT 0, sol_amount REAL, price_sol REAL);
         CREATE TABLE wallets (address TEXT PRIMARY KEY, funder TEXT);
         INSERT INTO wallet_swaps (wallet,signature,slot,ts,mint,side,token_amount,token_balance_before,sol_amount,price_sol) VALUES
           ('L','s1',1,'2026-01-01T00:00:00.000Z','M','buy',0.990099,0,1.0,1.01),
           ('L','s2',2,'2026-01-01T00:01:40.000Z','M','sell',1.010101,0.990099,2.0,1.98);
         INSERT INTO wallets VALUES ('L','F');",
    )
    .unwrap();
    drop(c);
    let ro = ge_flow::db::open_ro(&path).unwrap();
    assert!(
        ro.execute("CREATE TABLE x (a)", []).is_err(),
        "source connection must be read-only"
    );
    let swaps = ge_flow::db::load_swaps(&ro, None).unwrap();
    let funders = ge_flow::db::load_funders(&ro).unwrap();
    let leaders = ge_flow::db::load_leaders(&ro, &swaps, 5).unwrap();
    drop(ro);
    assert_eq!(
        (swaps.len(), leaders, funders["L"].as_str()),
        (2, vec!["L".to_string()], "F")
    );
    let m = Market::new(&swaps);
    let p = hand_params(0.0);
    let bt = backtest::backtest_all(&m, &["L".to_string()], &p, 1);
    let fl = analyse(&swaps, &funders, &FlowParams::default());
    ge_flow::db::write_results(&path, 123, &p, &bt, &fl).unwrap();
    ge_flow::db::write_results(&path, 123, &p, &bt, &fl).unwrap(); // idempotent
    let c = rusqlite::Connection::open(&path).unwrap();
    let (n, ret): (i64, f64) = c
        .query_row(
            "SELECT COUNT(*), MAX(copy_return_pct) FROM backtest_results",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(n, 1);
    assert!((ret - 89.73831887107939).abs() < 1e-9);
    let role: String = c
        .query_row(
            "SELECT role FROM wallet_clusters WHERE wallet='L'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(role, "independent");
    let _ = std::fs::remove_dir_all(&dir);
}
