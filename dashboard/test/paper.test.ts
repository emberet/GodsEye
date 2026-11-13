import { test } from "node:test";
import assert from "node:assert/strict";
import sitemap from "../app/sitemap";

test("the sitemap lists the Brain, How it works and Runners pages", () => {
  const urls = sitemap().map((p) => p.url);
  assert.ok(urls.some((u) => u.endsWith("/brain")));
  assert.ok(urls.some((u) => u.endsWith("/how")));
  assert.ok(!urls.some((u) => u.endsWith("/paper")));
  assert.ok(urls.some((u) => u.endsWith("/runners")));
});

test("the old /paper link redirects to /brain", async () => {
  const file = "../next.config.mjs"; // plain JS: imported by name so the typecheck doesn't look for its types
  const config = ((await import(file)) as { default: { redirects(): Promise<{ source: string; destination: string }[]> } }).default;
  const r = await config.redirects();
  assert.ok(r.some((x) => x.source === "/paper" && x.destination === "/brain"));
});
