// One-time setup helper: copies .env.example -> .env if you don't have one yet.
import fs from "node:fs";
if (!fs.existsSync(".env")) {
  fs.copyFileSync(".env.example", ".env");
  fs.chmodSync(".env", 0o600); // it will hold API keys: readable by its owner only
  console.log("Created .env from .env.example (paper mode) — open it and add HELIUS_API_KEY (and review the COPY_* money limits).");
} else {
  console.log(".env already exists — leaving it alone.");
}
fs.mkdirSync("data", { recursive: true });
