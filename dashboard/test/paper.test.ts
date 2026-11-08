import { test } from "node:test";
import assert from "node:assert/strict";
import sitemap from "../app/sitemap";

test("the sitemap lists the Paper AI and Runners pages", () => {
  const urls = sitemap().map((p) => p.url);
  assert.ok(urls.some((u) => u.endsWith("/paper")));
  assert.ok(urls.some((u) => u.endsWith("/runners")));
});
