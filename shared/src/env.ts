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

/** A setting's value as shown in an error: cut short, so a secret pasted into the wrong line is never printed whole. */
const shown = (raw: string) => (raw.length > 12 ? `${raw.slice(0, 12)}…` : raw);

/**
 * A number. Empty = the default. Anything that is not a number REFUSES TO START: a typo in a limit must never turn
 * into "the default, silently".
 */
export function envNum(name: string, fallback: number): number {
  const raw = envStr(name);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}="${shown(raw)}" in .env is not a number`);
  return n;
}

const YES = ["1", "true", "yes", "on"];
const NO = ["0", "false", "no", "off"];

/**
 * A yes/no switch. Empty = the default. An unknown word REFUSES TO START: it used to read as "no", so a typo could
 * switch a safety check off without a word.
 */
export function envBool(name: string, fallback: boolean): boolean {
  const raw = envStr(name).toLowerCase();
  if (raw === "") return fallback;
  if (YES.includes(raw)) return true;
  if (NO.includes(raw)) return false;
  throw new Error(`${name}="${shown(raw)}" in .env is not a yes or a no (use true or false)`);
}

/** One word from a fixed list (upper or lower case). Empty = the default. Any other word REFUSES TO START. */
export function envOneOf<T extends string>(name: string, allowed: readonly T[], fallback: NoInfer<T>): T {
  const raw = envStr(name).toLowerCase();
  if (raw === "") return fallback;
  const hit = allowed.find((a) => a === raw);
  if (hit === undefined) throw new Error(`${name}="${shown(raw)}" in .env is not one of: ${allowed.join(", ")}`);
  return hit;
}

export type OwnerOnly = "ok" | "tightened" | "open" | "missing";

/**
 * Makes a file that holds secrets (.env, the wallet key) readable by its owner only.
 *   ok         nobody else could read it
 *   tightened  others could; that is fixed now (mode 600)
 *   open       others can, and it could not be changed from here (the file belongs to someone else)
 *   missing    no such file
 * Windows has no such permission bits: always "ok" there.
 */
export function ownerOnly(file: string): OwnerOnly {
  if (process.platform === "win32") return "ok";
  const others = () => fs.statSync(file).mode & 0o077;
  try {
    if (others() === 0) return "ok";
  } catch {
    return "missing";
  }
  try {
    fs.chmodSync(file, 0o600);
    return others() === 0 ? "tightened" : "open";
  } catch {
    return "open";
  }
}

/** Path inside the project's data/ folder (created if missing). */
export function dataPath(...parts: string[]): string {
  const p = path.join(repoRoot(), "data", ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
