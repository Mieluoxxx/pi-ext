import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/dashboard.html", import.meta.url), "utf8");
const fmtSource = html
  .split("\n")
  .find((line) => line.includes("const fmt = n =>"))
  .split(", money =")[0]
  .replace("const fmt = n =>", "");
const fmt = new Function(`return (n =>${fmtSource})`)();

test("abbreviates large counts with K/M/B units", () => {
  assert.equal(fmt(0), "0");
  assert.equal(fmt(930), "930");
  assert.equal(fmt(999), "999");
  assert.equal(fmt(1000), "1K");
  assert.equal(fmt(57314), "57.3K");
  assert.equal(fmt(1e6), "1M");
  assert.equal(fmt(350754202), "350.75M");
  assert.equal(fmt(14978570853), "14.98B");
  assert.equal(fmt(-2e6), "-2M");
});

test("layout keeps panels shrinkable instead of overflowing their container", () => {
  assert.ok(!html.includes("min-width: 850px"), "table must not force a fixed 850px width");
  assert.ok(html.includes("grid-template-columns: minmax(0, 1fr)"), "stat-list must clamp its implicit column");
  assert.ok(html.includes(".legend .name { flex: 1 1 auto; min-width: 0;"), "legend name must be allowed to shrink");
  assert.ok(html.includes(".grid.trio { grid-template-columns: repeat(3, minmax(0, 1fr)); }"), "trio panels must clamp their columns");
});
