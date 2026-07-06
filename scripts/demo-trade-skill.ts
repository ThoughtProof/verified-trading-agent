// Live dryrun of the trading skill: a clean long + a fabricated-thesis short,
// through the real Sentinel API. Proves the gate ALLOWs the defensible one and
// BLOCK/UNCERTAINs the indefensible one, and that mm is only reached on ALLOW.
import "dotenv/config";
import { runTradeSkill } from "../src/trade-skill.js";
import type { TradeDecision, MarketSnapshot } from "../src/types.js";

const apiKey = process.env.THOUGHTPROOF_API_KEY ?? process.env.SENTINEL_API_KEY ?? "";

const market: MarketSnapshot = {
  symbol: "ETHUSDT", price: 1800, priceChangePct24h: 4.2, high24h: 1850, low24h: 1750, volume24h: 9_500_000_000,
  technicals: {
    change7dPct: 12, change14dPct: 8, sma7: 1750, sma30: 1700,
    vsSma7: "above", vsSma30: "above", rsi14: 56, consecutiveCloses: 3, trend: "uptrend",
  },
} as MarketSnapshot;

const clean: TradeDecision = {
  action: "open 2x long ETH", side: "long", leverage: 2,
  thesis: "ETH holds above rising SMA7 (1750) and SMA30 (1700); RSI 56 not overbought — measured long, invalidation below SMA7.",
  reasoning: "Uptrend structure intact across 7d/14d; entry with defined risk.",
} as TradeDecision;

const fabricated: TradeDecision = {
  action: "open 3x short ETH", side: "short", leverage: 3,
  thesis: "ETH is in a strong downtrend, RSI at 82 screaming overbought, price broke below SMA200 at 2400 with a death cross confirmed today.",
  reasoning: "Momentum has flipped bearish, all indicators aligned short.",
} as TradeDecision;

(async () => {
  console.log("ThoughtProof Trading Skill — pre-trade reasoning guard demo");
  console.log(`MM_EXECUTION_MODE = ${process.env.MM_EXECUTION_MODE ?? "off"}\n`);
  for (const [label, d] of [["CLEAN long", clean], ["FABRICATED short (RSI/SMA/death-cross invented)", fabricated]] as const) {
    const r = await runTradeSkill(d, market, { apiKey });
    console.log("━".repeat(60));
    console.log(`${label}`);
    console.log(`  verdict:  ${r.verification.finalVerdict} (route ${r.verification.route})`);
    console.log(`  skill:    [${r.execution.status}] ${r.execution.note.split("\n")[0]}`);
  }
})();
