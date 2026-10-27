// Node baseline for the Rust criterion bench (rust/ingest/crates/ge-parse/benches/parse.rs): convertGrpcTx + parseSwaps
// for every signer over the same fixtures, inputs pre-decoded so both sides time the same work.
// Usage: npm run bench:parse -w agent
import { join } from "node:path";
import { parseSwaps } from "../chain/parse";
import { convertGrpcTx } from "../stream/convert";
import { fixtureToGrpc, type FixtureTx } from "../stream/fixture";
import { FIXTURE_DIR, readNdjson } from "./rust-fixtures";

function bench(set: string): void {
  const txs = readNdjson<FixtureTx>(join(FIXTURE_DIR, `${set}.ndjson`)).map((fx) => ({ info: fixtureToGrpc(fx), fx }));
  const pass = (): number => {
    let n = 0;
    for (const { info, fx } of txs) {
      const conv = convertGrpcTx(info, fx.slot, fx.receivedAtMs);
      if (!conv) continue;
      const price = fx.solUsd;
      for (const s of conv.signers) n += parseSwaps(conv.tx, s, { solUsdAt: () => price }).length;
    }
    return n;
  };
  for (let i = 0; i < 20; i++) pass(); // warm up the JIT
  const samples: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t = process.hrtime.bigint();
    pass();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[samples.length >> 1];
  console.log(`convert+parse/${set}: ${txs.length} tx, median ${med.toFixed(3)} ms/pass, ${Math.round((txs.length / med) * 1000)} tx/s (min ${samples[0].toFixed(3)} ms, max ${samples[samples.length - 1].toFixed(3)} ms)`);
}

for (const set of ["real", "synthetic"]) bench(set);
