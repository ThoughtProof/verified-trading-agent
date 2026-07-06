// Unit tests for the trading skill's composition + gating contract.
// Pure/deterministic where possible; the verdict-gating (only ALLOW touches mm)
// is exercised through executeViaMetaMask with MM_EXECUTION_MODE=off so no real
// Sentinel call or mm binary is needed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getExecutionMode } from "./trade-skill.js";
import { buildMmCommand, executeViaMetaMask } from "./metamask-executor.js";
import type { TradeDecision, MarketSnapshot } from "./types.js";

const market: MarketSnapshot = {
  symbol: "ETHUSDT",
  price: 1800,
  priceChangePct24h: 4.2,
  high24h: 1850,
  low24h: 1750,
  volume24h: 9_500_000_000,
  technicals: { change7dPct: 12, change14dPct: 8, sma7: 1750, sma30: 1700, rsi14: 56 } as MarketSnapshot["technicals"],
} as MarketSnapshot;

const longDecision: TradeDecision = {
  action: "open 2x long ETH",
  side: "long",
  leverage: 2,
  thesis: "ETH holding above rising SMA7/SMA30, RSI 56 leaves room.",
  reasoning: "Uptrend intact, measured long with invalidation below SMA7.",
} as TradeDecision;

describe("trade-skill gating contract (MM_EXECUTION_MODE=off)", () => {
  const prev = process.env.MM_EXECUTION_MODE;
  beforeEach(() => { process.env.MM_EXECUTION_MODE = "off"; });
  afterEach(() => {
    if (prev === undefined) delete process.env.MM_EXECUTION_MODE;
    else process.env.MM_EXECUTION_MODE = prev;
  });

  it("off mode never touches mm even on ALLOW", async () => {
    const res = await executeViaMetaMask("ALLOW", longDecision, market);
    expect(res.status).toBe("disabled");
  });

  it("BLOCK never invokes mm (fail-closed headline)", async () => {
    process.env.MM_EXECUTION_MODE = "dryrun";
    const res = await executeViaMetaMask("BLOCK", longDecision, market);
    expect(res.status).toBe("blocked-before-mm");
    expect(res.note).toContain("NEVER invoked");
  });

  it("UNCERTAIN never invokes mm (not a soft pass)", async () => {
    process.env.MM_EXECUTION_MODE = "dryrun";
    const res = await executeViaMetaMask("UNCERTAIN", longDecision, market);
    expect(res.status).toBe("blocked-before-mm");
  });

  it("flat is a no-op, never touches mm", async () => {
    process.env.MM_EXECUTION_MODE = "live";
    const flat: TradeDecision = { ...longDecision, side: "flat", action: "stay flat" };
    const res = await executeViaMetaMask("ALLOW", flat, market);
    expect(res.status).toBe("skipped-flat");
  });
});

describe("buildMmCommand (trade path, mm v4.0.0 perps syntax)", () => {
  it("builds `mm perps open` with base-asset size, leverage, testnet", () => {
    const cmd = buildMmCommand(longDecision, market);
    expect(cmd).not.toBeNull();
    expect(cmd!.args.slice(0, 3)).toEqual(["perps", "open", "--venue"]);
    expect(cmd!.args).toContain("--symbol");
    expect(cmd!.args).toContain("--side");
    expect(cmd!.args).toContain("long");
    expect(cmd!.args).toContain("--leverage");
    expect(cmd!.args).toContain("--network");
    expect(cmd!.args).toContain("testnet");
  });

  it("returns null for a flat decision", () => {
    const flat: TradeDecision = { ...longDecision, side: "flat" };
    expect(buildMmCommand(flat, market)).toBeNull();
  });
});

describe("getExecutionMode", () => {
  const prev = process.env.MM_EXECUTION_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MM_EXECUTION_MODE;
    else process.env.MM_EXECUTION_MODE = prev;
  });
  it("defaults to off", () => {
    delete process.env.MM_EXECUTION_MODE;
    expect(getExecutionMode()).toBe("off");
  });
});
