//! convert + parse throughput over the golden fixtures (same workload as agent/src/cli/parse-bench.ts).
use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use ge_parse::fixture::FixtureTx;
use ge_parse::{convert_grpc_tx, swaps_for_update, ParseOptions};

fn load(set: &str) -> Vec<(ge_parse::GrpcTxInfo, u64, f64, Option<f64>)> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../fixtures/{set}.ndjson"));
    std::fs::read_to_string(p)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let fx = FixtureTx::parse_line(l).unwrap();
            (
                fx.to_grpc().unwrap(),
                fx.slot,
                fx.received_at_ms,
                fx.sol_usd,
            )
        })
        .collect()
}

fn bench(c: &mut Criterion) {
    let mut g = c.benchmark_group("convert+parse");
    for set in ["real", "synthetic"] {
        let txs = load(set);
        g.throughput(Throughput::Elements(txs.len() as u64));
        g.bench_function(set, |b| {
            b.iter(|| {
                let mut n = 0usize;
                for (info, slot, at, price) in &txs {
                    let f = move |_: f64| *price;
                    let opts = ParseOptions {
                        sol_usd_at: Some(&f),
                    };
                    if let Some(c) = convert_grpc_tx(info, *slot, *at) {
                        n += swaps_for_update(&c, &opts).len();
                    }
                }
                std::hint::black_box(n)
            })
        });
    }
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
