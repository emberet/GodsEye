import { Connection } from "@solana/web3.js";
import { rpcUrl, wsUrl } from "./config";

let conn: Connection | null = null;
export function connection(): Connection {
  if (!conn) conn = new Connection(rpcUrl(), { commitment: "confirmed", wsEndpoint: wsUrl() });
  return conn;
}
