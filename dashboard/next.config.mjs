import path from "node:path";
import dotenv from "dotenv";

// One .env for the whole project (in the folder above this one).
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env") });
// Where the database lives, for the server only (next.config `env` would also bake it into browser code).
process.env.GODSEYE_ROOT ??= path.resolve(process.cwd(), "..");

const dev = process.env.NODE_ENV !== "production";
// Next.js injects inline bootstrap scripts and styles, so script/style need 'unsafe-inline' without nonces.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
export const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@godseye/shared"],
  experimental: { serverComponentsExternalPackages: ["better-sqlite3", "@libsql/client", "libsql"] },
  // The public site builds into its own folder so it doesn't clobber the dev server's .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
export default nextConfig;
