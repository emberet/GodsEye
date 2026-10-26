/**
 * Loaded before every test file (`tsx --import`). Tests must never touch the real wallet, the real
 * database or the network, whatever is in the project's .env:
 *   • the project root becomes a fresh temp folder with an empty .env (so no keys, no COPY_MODE=real);
 *   • paper mode, an unreachable RPC, no gRPC, no rug-check network calls;
 *   • GODSEYE_TEST=1, which makes the wallet loader, RealExecutor and openDb() on a real path refuse;
 *   • fetch throws unless a test stubs it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "godseye-test-"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "godseye" }));
fs.writeFileSync(path.join(root, ".env"), "");
fs.mkdirSync(path.join(root, "data"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const env: Record<string, string> = {
  GODSEYE_ROOT: root,
  GODSEYE_TEST: "1",
  COPY_MODE: "paper",
  SOLANA_RPC_URL: "http://127.0.0.1:9",
  SOLANA_WS_URL: "ws://127.0.0.1:9",
  HELIUS_API_KEY: "",
  SHYFT_API_KEY: "",
  BIRDEYE_API_KEY: "",
  JUPITER_API_KEY: "",
  GRPC_URL: "",
  GRPC_TOKEN: "",
  RUG_CHECK_ENABLED: "false",
};
for (const [k, v] of Object.entries(env)) process.env[k] = v;
delete process.env.GODSEYE_DB_PATH;
delete process.env.AGENT_KEYPAIR_PATH;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Test tried to reach the network (${new URL(url).host}): stub fetch for this test.`);
}) as typeof fetch;
