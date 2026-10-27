//! The full per-update hot path of ge-ingest: protobuf decode -> convert -> parse -> event line.
use criterion::{criterion_group, criterion_main, Criterion, Throughput};
use ge_ingest::event::event_line;
use ge_ingest::pb::geyser::SubscribeUpdateTransactionInfo;
use ge_ingest::{info_from_proto, proto_from_info};
use ge_parse::fixture::FixtureTx;
use ge_parse::{convert_grpc_tx, swaps_for_update, ParseOptions};
use prost::Message;

fn bench(c: &mut Criterion) {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/real.ndjson");
    let txs: Vec<(Vec<u8>, u64, f64)> = std::fs::read_to_string(p)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let fx = FixtureTx::parse_line(l).unwrap();
            (
                proto_from_info(&fx.to_grpc().unwrap()).encode_to_vec(),
                fx.slot,
                fx.received_at_ms,
            )
        })
        .collect();
    let opts = ParseOptions { sol_usd_at: None };
    let mut g = c.benchmark_group("decode+convert+parse+event");
    g.throughput(Throughput::Elements(txs.len() as u64));
    g.bench_function("real", |b| {
        b.iter(|| {
            let mut bytes = 0usize;
            for (buf, slot, at) in &txs {
                let info = info_from_proto(
                    &SubscribeUpdateTransactionInfo::decode(buf.as_slice()).unwrap(),
                );
                if let Some(conv) = convert_grpc_tx(&info, *slot, *at) {
                    bytes += event_line(&conv, &swaps_for_update(&conv, &opts), *at, None).len();
                }
            }
            std::hint::black_box(bytes)
        })
    });
    g.bench_function("decode-only", |b| {
        b.iter(|| {
            let mut n = 0usize;
            for (buf, _, _) in &txs {
                n += info_from_proto(
                    &SubscribeUpdateTransactionInfo::decode(buf.as_slice()).unwrap(),
                )
                .signature
                .len();
            }
            std::hint::black_box(n)
        })
    });
    let convs: Vec<_> = txs
        .iter()
        .filter_map(|(buf, slot, at)| {
            let info =
                info_from_proto(&SubscribeUpdateTransactionInfo::decode(buf.as_slice()).unwrap());
            convert_grpc_tx(&info, *slot, *at).map(|c| (c, *at))
        })
        .collect();
    g.bench_function("event-line-only", |b| {
        b.iter(|| {
            let mut n = 0usize;
            for (conv, at) in &convs {
                n += event_line(conv, &[], *at, None).len();
            }
            std::hint::black_box(n)
        })
    });
    g.finish();
}

criterion_group!(benches, bench);
criterion_main!(benches);
