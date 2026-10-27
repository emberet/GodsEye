//! Replay throughput on a synthetic market. Reports trades (leader round trips) replayed per second.
use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use ge_flow::{backtest, flow, synth};
use std::collections::HashMap;

fn bench(c: &mut Criterion) {
    let (leaders, per, noise) = (200usize, 50usize, 40usize);
    let swaps = synth::market(leaders, per, noise, 42);
    let names: Vec<String> = (0..leaders).map(|l| format!("L{l}")).collect();
    let market = backtest::Market::new(&swaps);
    let p = backtest::Params::default();
    let mut g = c.benchmark_group("replay");
    g.sample_size(10);
    g.throughput(Throughput::Elements((leaders * per) as u64));
    g.bench_function("backtest_1_thread", |b| {
        b.iter(|| backtest::backtest_all(&market, &names, &p, 1))
    });
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    g.bench_function(format!("backtest_{n}_threads"), |b| {
        b.iter(|| backtest::backtest_all(&market, &names, &p, n))
    });
    g.throughput(Throughput::Elements(swaps.len() as u64));
    g.bench_function("flow_analyse_swaps", |b| {
        b.iter(|| flow::analyse(&swaps, &HashMap::new(), &flow::FlowParams::default()))
    });
    g.finish();
}
criterion_group!(benches, bench);
criterion_main!(benches);
