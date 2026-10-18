/**
 * Finds the project folder and loads the single shared .env file,
 * so every part of GodsEye uses the same settings.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

let cachedRoot: string | null = null;

/** The GodsEye project root (the folder with the top-level package.json). */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (process.env.GODSEYE_ROOT) return (cachedRoot = path.resolve(process.env.GODSEYE_ROOT));
  let dir = process.cwd();
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, "utf8")).name === "godseye") return (cachedRoot = dir);
      } catch {
        /* keep walking up */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (cachedRoot = process.cwd());
}

let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  dotenv.config({ path: path.join(repoRoot(), ".env"), quiet: true } as dotenv.DotenvConfigOptions);
}

export function envStr(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export function envNum(name: string, fallback: number): number {
  const raw = envStr(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`⚠️  .env value ${name}="${raw}" is not a number — using default ${fallback}`);
    return fallback;
  }
  return n;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = envStr(name).toLowerCase();
  if (raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

/** Path inside the project's data/ folder (created if missing). */
export function dataPath(...parts: string[]): string {
  const p = path.join(repoRoot(), "data", ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
