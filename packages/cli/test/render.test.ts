import assert from "node:assert/strict";
import { test } from "node:test";

import { BAR_WIDTH, GLYPH, fit, makeStyle, pct, stackedBar } from "../src/render.js";

const plain = makeStyle({ isTty: false, env: {} });
const id = (s: string) => s;

test("colour is off when stdout is not a terminal", () => {
  assert.equal(makeStyle({ isTty: false, env: {} }).enabled, false);
  assert.equal(makeStyle({ isTty: true, env: {} }).enabled, true);
});

test("NO_COLOR disables colour even on a terminal and even when empty", () => {
  assert.equal(makeStyle({ isTty: true, env: { NO_COLOR: "1" } }).enabled, false);
  assert.equal(makeStyle({ isTty: true, env: { NO_COLOR: "" } }).enabled, false);
  // NO_COLOR outranks FORCE_COLOR. no-color.org treats presence as decisive.
  assert.equal(makeStyle({ isTty: true, env: { NO_COLOR: "", FORCE_COLOR: "1" } }).enabled, false);
});

test("a disabled style is the identity function, so output stays pipe-safe", () => {
  assert.equal(plain.sustainable("x"), "x");
  assert.equal(plain.bold("x"), "x");
  assert.ok(!plain.counterparty("x").includes(""));
});

test("the three yield kinds use distinct glyphs, not just distinct colours", () => {
  const glyphs = new Set([GLYPH.sustainable, GLYPH.emissions, GLYPH.counterparty]);
  assert.equal(glyphs.size, 3);
  // A reader with no colour, or no colour vision, must still be able to tell
  // the segments apart. That is the whole point of the split.
  const bar = stackedBar(
    [
      { bps: 500, glyph: GLYPH.sustainable, paint: id },
      { bps: 300, glyph: GLYPH.emissions, paint: id },
      { bps: 200, glyph: GLYPH.counterparty, paint: id },
    ],
    1000,
  );
  assert.ok(bar.includes(GLYPH.sustainable));
  assert.ok(bar.includes(GLYPH.emissions));
  assert.ok(bar.includes(GLYPH.counterparty));
});

test("the bar is always exactly the declared width", () => {
  const cases: [number, number, number][] = [
    [1000, 0, 0],
    [500, 300, 200],
    [1, 1, 9998],
    [0, 0, 0],
  ];
  for (const [s, e, c] of cases) {
    const bar = stackedBar(
      [
        { bps: s, glyph: GLYPH.sustainable, paint: id },
        { bps: e, glyph: GLYPH.emissions, paint: id },
        { bps: c, glyph: GLYPH.counterparty, paint: id },
      ],
      s + e + c,
    );
    assert.equal([...bar].length, BAR_WIDTH, `width for ${s}/${e}/${c}`);
  }
});

test("a tiny but non-zero segment still gets a cell", () => {
  // 1 bps out of 10000 rounds to zero cells. Dropping it would render a real
  // exposure as absent, which is the misreading this tool exists to prevent.
  const bar = stackedBar(
    [
      { bps: 9999, glyph: GLYPH.sustainable, paint: id },
      { bps: 1, glyph: GLYPH.counterparty, paint: id },
    ],
    10000,
  );
  assert.ok(bar.includes(GLYPH.counterparty), "1 bps of counterparty must still be visible");
  assert.equal([...bar].length, BAR_WIDTH);
});

test("a genuinely zero segment gets no cell", () => {
  const bar = stackedBar(
    [
      { bps: 1000, glyph: GLYPH.sustainable, paint: id },
      { bps: 0, glyph: GLYPH.emissions, paint: id },
    ],
    1000,
  );
  assert.ok(!bar.includes(GLYPH.emissions), "zero emissions must not draw a segment");
});

test("a zero total renders an empty bar rather than dividing by zero", () => {
  const bar = stackedBar([{ bps: 0, glyph: GLYPH.sustainable, paint: id }], 0);
  assert.equal([...bar].length, BAR_WIDTH);
  assert.equal(bar, GLYPH.empty.repeat(BAR_WIDTH));
});

test("pct renders basis points at two decimals", () => {
  assert.equal(pct(807), "8.07%");
  assert.equal(pct(0), "0.00%");
  assert.equal(pct(18033), "180.33%");
});

test("fit pads short values and truncates long ones to a fixed width", () => {
  assert.equal(fit("Orca", 8), "Orca    ");
  assert.equal(fit("Kamino Liquidity", 8).length, 8);
  assert.equal(fit("BTC-USDC vault share", 12).length, 12);
  // Overflow must not push later columns out of alignment.
  assert.ok(fit("cbBTC / WBTC / xBTC / LBTC", 12).endsWith(". "));
});
