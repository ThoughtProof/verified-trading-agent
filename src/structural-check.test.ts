import { describe, it, expect } from "vitest";
import { structuralCheck } from "./structural-check.js";
import type { TradeDecision, MarketSnapshot } from "./types.js";

// Build a minimal MarketSnapshot. ch7 = 7d window trend (drives direction flag),
// ch24 = 24h change, hi/lo = 24h range (drives range-position flag).
function mkt(price: number, ch24: number, hi: number, lo: number, ch7: number): MarketSnapshot {
  return {
    symbol: "TESTUSDT",
    price,
    priceChangePct24h: ch24,
    high24h: hi,
    low24h: lo,
    volume24h: 1_000_000,
    fetchedAt: new Date().toISOString(),
    technicals: {
      change7dPct: ch7,
      change14dPct: 0,
      sma7: price,
      sma30: price,
      vsSma7: "above",
      vsSma30: "above",
      rsi14: 55,
      consecutiveCloses: 1,
    },
  } as MarketSnapshot;
}

function dec(thesis: string, reasoning = ""): TradeDecision {
  return {
    symbol: "TESTUSDT",
    side: "long",
    leverage: 2,
    action: "open 2x long TEST",
    thesis,
    reasoning,
    stakeLevel: "low",
    highStakes: false,
  } as TradeDecision;
}

const kinds = (r: ReturnType<typeof structuralCheck>) => r.flags.map((f) => f.kind).sort();

describe("structuralCheck — no hard block path (post-steelman)", () => {
  it("never returns a contradiction/hard-block field", () => {
    const r = structuralCheck(dec("Strong uptrend, momentum continuation."), mkt(100, -2, 120, 95, -12));
    // Result shape is flags-only.
    expect(Object.keys(r)).toEqual(["flags"]);
  });
});

describe("direction coherence → SOFT flag only", () => {
  it("flags (does NOT block) an uptrend claim against a decisive 7d downtrend", () => {
    const r = structuralCheck(dec("Strong uptrend, bullish breakout continuation."), mkt(100, -2, 120, 95, -12));
    expect(kinds(r)).toContain("direction");
    // Crucially: it's a flag, not a block — the caller forwards it to Sentinel.
    expect(r.flags.find((f) => f.kind === "direction")?.evidenceLine).toMatch(/structural_fact/);
  });

  it("stays SILENT on an aligned uptrend claim (+12% 7d)", () => {
    const r = structuralCheck(dec("Strong uptrend, price above SMA7."), mkt(100, 1, 105, 90, 12));
    expect(kinds(r)).not.toContain("direction");
  });

  it("stays SILENT when no unambiguous direction word is present", () => {
    const r = structuralCheck(dec("Price consolidating near support, neutral RSI."), mkt(100, 1, 105, 90, -12));
    expect(kinds(r)).not.toContain("direction");
  });

  it("stays SILENT when both bullish AND bearish words fire (ambiguous → null)", () => {
    const r = structuralCheck(dec("Despite the recent downtrend, an uptrend structure is forming."), mkt(100, 1, 105, 90, -12));
    // both-fire → extractDirection returns null → no direction flag
    expect(kinds(r)).not.toContain("direction");
  });

  it("stays SILENT on a noisy market below the 3% direction tolerance", () => {
    const r = structuralCheck(dec("Clear downtrend, bearish."), mkt(100, -1, 105, 90, -1.5));
    expect(kinds(r)).not.toContain("direction");
  });

  it("CONTRARIAN trade (long a 7d-down asset) is flagged, not blocked — Sentinel judges", () => {
    // The exact steelman case: oversold-bounce long. Must NOT hard-block.
    const r = structuralCheck(
      dec("Oversold bounce setup; bullish divergence on a beaten-down name.", "RSI washed out."),
      mkt(100, -1, 130, 95, -14),
    );
    // A direction flag may fire, but there is no block — the result is flags-only
    // and the caller always proceeds to Sentinel with the fact attached.
    expect(Object.keys(r)).toEqual(["flags"]);
  });
});

describe("magnitude → soft flag", () => {
  it("flags an exaggerated %-move claim beyond 10pp", () => {
    const r = structuralCheck(dec("Momentum up 45% makes this a strong long."), mkt(100, 8, 105, 90, 9));
    expect(kinds(r)).toContain("magnitude");
  });

  it("stays SILENT when the claimed move is within tolerance of a verified figure", () => {
    const r = structuralCheck(dec("Price up 9% on the day."), mkt(100, 8, 105, 90, 2));
    expect(kinds(r)).not.toContain("magnitude");
  });

  it("flags the single move %-claim even when non-move percentages co-occur", () => {
    // "0.4x" has no %, "76% of range" is a RANGE pattern not a move pattern, so
    // the only move-magnitude extracted is 45% → correctly flagged vs +8% 24h.
    const r = structuralCheck(dec("Up 45% on 0.4x volume, sitting at 76% of range."), mkt(100, 8, 105, 90, 9));
    expect(kinds(r)).toContain("magnitude");
  });

  it("stays SILENT when two conflicting move magnitudes make extraction ambiguous", () => {
    // "up 45%" and "+12%" are both move-patterns with distinct values → ambiguous → silent
    const r = structuralCheck(dec("Up 45% this week, +12% today — strong."), mkt(100, 8, 105, 90, 9));
    expect(kinds(r)).not.toContain("magnitude");
  });
});

describe("range position → soft flag", () => {
  it("flags a range-position claim off by more than 15pp", () => {
    // price at 10% of [90,110] range; thesis claims 80% of range
    const r = structuralCheck(dec("Trading near 80% of its range, pressing highs."), mkt(92, 1, 110, 90, 1));
    expect(kinds(r)).toContain("range_position");
  });

  it("stays SILENT when the range claim is within tolerance", () => {
    // price at 90% of [90,110]; thesis claims ~85%
    const r = structuralCheck(dec("About 85% of the range."), mkt(108, 1, 110, 90, 1));
    expect(kinds(r)).not.toContain("range_position");
  });
});

describe("robustness / fail-toward-silence", () => {
  it("returns empty flags when technicals are absent (no 7d trend to check)", () => {
    const m = mkt(100, 1, 105, 90, 5);
    // strip technicals
    (m as { technicals?: unknown }).technicals = undefined;
    const r = structuralCheck(dec("Strong uptrend."), m);
    // direction check needs trendPct; without it → silent
    expect(kinds(r)).not.toContain("direction");
  });

  it("never throws on empty thesis/reasoning", () => {
    expect(() => structuralCheck(dec("", ""), mkt(100, 1, 105, 90, 5))).not.toThrow();
  });

  it("returns empty flags on a degenerate range (high == low)", () => {
    const r = structuralCheck(dec("At 80% of range."), mkt(100, 1, 100, 100, 1));
    expect(kinds(r)).not.toContain("range_position");
  });
});
