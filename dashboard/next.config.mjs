import path from "node:path";
import dotenv from "dotenv";

// One .env for the whole project (in the folder above this one).
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env") });
// Where the database lives, for the server only (next.config `env` would also bake it into browser code).
process.env.GODSEYE_ROOT ??= path.resolve(process.cwd(), "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@godseye/shared"],
  experimental: { serverComponentsExternalPackages: ["better-sqlite3", "@libsql/client", "libsql"] },
  // The public site builds into its own folder so it doesn't clobber the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};
export default nextConfig;
