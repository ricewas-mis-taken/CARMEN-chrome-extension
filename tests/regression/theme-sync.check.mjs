// Regression: the popup wears the desktop's theme. The six colours from GET /theme
// become the popup's CSS variables, derived the way the desktop derives its tints.
// Usage: node tests/regression/theme-sync.check.mjs   (exit 1 = bug)
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

for (const dir of ["chrome", "firefox"]) {
  const file = path.resolve(dir, "core", "theme-sync.js");
  const { themeVariables } = await import(pathToFileURL(file).href);
  const v = themeVariables({ ink: "#2A1F1B", muted: "#7A6A63", faint: "#B09F97", accent: "#C2623F", page: "#FAF6F2", sidebar: "#231915" });
  assert.equal(v["--accent"], "#C2623F", dir);
  assert.equal(v["--ink"], "#2A1F1B", dir);
  assert.equal(v["--ink-3"], "#7A6A63", dir);
  assert.match(v["--accent-soft"], /^#[0-9a-f]{6}$/, dir);
  assert.notEqual(v["--accent-strong"], v["--accent"], dir);
  // the soft tint is nearly white, the strong one darker than the accent
  assert.ok(parseInt(v["--accent-soft"].slice(1, 3), 16) > 0xe0, dir);
  assert.ok(parseInt(v["--accent-strong"].slice(1, 3), 16) < 0xc2, dir);
}
console.log("theme-sync: ok");
