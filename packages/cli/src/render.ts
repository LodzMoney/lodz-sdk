/**
 * Terminal rendering.
 *
 * Two rules shape everything here.
 *
 * Colour is decoration, never information. The three yield kinds are told
 * apart by their glyph and their label, so the output survives a pipe, a
 * NO_COLOR terminal and a screen reader. A bar that only distinguishes its
 * segments by hue tells a colour-blind reader that the whole return is one
 * thing, which is the exact misreading this tool exists to prevent.
 *
 * No emoji anywhere. Box-drawing and block glyphs only.
 */

export const BAR_WIDTH = 56;

/** Distinct fill glyphs per yield kind. Legible without colour. */
export const GLYPH = {
  sustainable: "█", // full block
  emissions: "▒", // medium shade
  counterparty: "▓", // dark shade
  empty: "─", // light horizontal
} as const;

export interface Style {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  sustainable(s: string): string;
  emissions(s: string): string;
  counterparty(s: string): string;
  warn(s: string): string;
}

/**
 * Colour is enabled only for a TTY, and NO_COLOR wins over everything.
 * See no-color.org: any value, including an empty one, disables colour.
 */
export function makeStyle(opts: { isTty: boolean; env: Record<string, string | undefined> }): Style {
  const forced = opts.env["FORCE_COLOR"];
  const noColor = opts.env["NO_COLOR"] !== undefined;
  const enabled = !noColor && (forced !== undefined ? forced !== "0" : opts.isTty);
  const wrap = (code: string) => (s: string) => (enabled ? `[${code}m${s}[0m` : s);
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    sustainable: wrap("33"), // headlamp yellow
    emissions: wrap("90"), // dust grey: it is meant to look like it fades
    counterparty: wrap("38;5;166"), // hazard orange: not the same thing as fees
    warn: wrap("38;5;166"),
  };
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Fit a value into a fixed column. Overflow is truncated with a single-cell
 * ellipsis rather than allowed to push every later column out of alignment,
 * which is what turns a table into unreadable text.
 */
export function fit(s: string, n: number): string {
  if (s.length <= n) return padRight(s, n);
  return n <= 1 ? s.slice(0, n) : `${s.slice(0, n - 2)}. `;
}

export function btc(n: number): string {
  return n.toFixed(8);
}

export interface BarSegment {
  readonly bps: number;
  readonly glyph: string;
  readonly paint: (s: string) => string;
}

/**
 * A stacked bar over `total` bps.
 *
 * A segment that is present but rounds below one cell is still given one cell,
 * because dropping it renders a real exposure as absent. A segment that is
 * genuinely zero gets none.
 */
export function stackedBar(segments: readonly BarSegment[], total: number, width = BAR_WIDTH): string {
  if (total <= 0) return GLYPH.empty.repeat(width);

  const present = segments.filter((s) => s.bps > 0);
  if (present.length === 0) return GLYPH.empty.repeat(width);

  // Floor allocation, reserving at least one cell for every non-zero segment.
  const alloc = present.map((seg) => {
    const exact = (seg.bps / total) * width;
    return { seg, exact, n: Math.max(1, Math.floor(exact)) };
  });

  let used = alloc.reduce((sum, a) => sum + a.n, 0);

  // Hand out any slack by largest fractional remainder.
  while (used < width) {
    let best = -1;
    let bestFrac = -1;
    for (let i = 0; i < alloc.length; i += 1) {
      const a = alloc[i];
      if (!a) continue;
      const frac = a.exact - a.n;
      if (frac > bestFrac) {
        bestFrac = frac;
        best = i;
      }
    }
    if (best < 0) break;
    const chosen = alloc[best];
    if (!chosen) break;
    chosen.n += 1;
    used += 1;
  }

  // Over budget only because of those reserved minimums. Reclaim from the
  // widest segment, never from the end of the row: the last cells belong to
  // the smallest segment, which is exactly the one the minimum protects.
  while (used > width) {
    let widest = -1;
    let widestN = 1;
    for (let i = 0; i < alloc.length; i += 1) {
      const a = alloc[i];
      if (!a) continue;
      if (a.n > widestN) {
        widestN = a.n;
        widest = i;
      }
    }
    if (widest < 0) break;
    const chosen = alloc[widest];
    if (!chosen) break;
    chosen.n -= 1;
    used -= 1;
  }

  const cells: string[] = [];
  for (const a of alloc) {
    for (let i = 0; i < a.n; i += 1) cells.push(a.seg.paint(a.seg.glyph));
  }
  while (cells.length < width) cells.push(GLYPH.empty);
  return cells.slice(0, width).join("");
}

export function rule(width = BAR_WIDTH + 4): string {
  return "─".repeat(width);
}

/** `key ...... value` with a dotted leader. */
export function kv(label: string, value: string, labelWidth = 30, style?: Style): string {
  const l = padRight(label, labelWidth);
  return style ? `${style.dim(l)}${value}` : `${l}${value}`;
}
