// Standalone demo: ThoughtProof × MetaMask Agent Wallet integration.
//
// Proves the integration shape WITHOUT the live loop and WITHOUT real funds.
// Feeds the executor two hand-built decisions — one the verifier would ALLOW,
// one it would BLOCK — and shows the headline result:
//
//   • BLOCK  → `mm` is NEVER invoked. The transaction never enters MetaMask's
//              security pipeline. ThoughtProof stopped it one layer earlier.
//   • ALLOW  → the exact `mm perps open` command is built. If the `mm` CLI is
//              installed and logged in, a READ-ONLY `mm perps quote` is run to
//              validate the command against the real @metamask/agentic-sdk.
//              (`mm perps open` is only ever run in MM_EXECUTION_MODE=live.)
//
// Usage:
//   MM_EXECUTION_MODE=dryrun npx tsx scripts/demo-metamask-integration.ts
//
// This is the artifact for the MetaMask kick-off: "I wired ThoughtProof into a
// MetaMask Agent Wallet executor over the weekend. Here it is running."

import "dotenv/config";
import { executeViaMetaMask, getExecutionMode, probeMm } from "../src/metamask-executor.js";
import type { TradeDecision, MarketSnapshot, Verdict } from "../src/types.js";

function market(symbol: string, price: number, overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol,
    price,
    priceChangePct24h: 0,
    high24h: price * 1.05,
    low24h: price * 0.95,
    volume24h: 50_000_000,
    fetchedAt: new Date().toISOString(),
    venue: "cex",
    ...overrides,
  };
}

// A defensible decision (the kind RV would ALLOW): clear edge, invalidation,
// modest leverage.
const goodDecision: TradeDecision = {
  symbol: "ETHUSDT",
  side: "long",
  leverage: 2,
  action: "open 2x long ETH, 100 USDC margin",
  thesis:
    "ETH reclaimed the $3,200 weekly level on rising volume with a higher low at $3,050 (invalidation). 2x sized to the structure. Counter: a daily close back below $3,050 voids the thesis.",
  reasoning: "Multi-factor: level reclaim + volume confirmation + defined invalidation. Conservative size.",
  highStakes: false,
};

// An indefensible decision (the kind RV would BLOCK): hallucinated thesis,
// no invalidation, overleveraged chase on a parabolic micro-cap.
const badDecision: TradeDecision = {
  symbol: "AIOUSDT",
  side: "long",
  leverage: 5,
  action: "open 5x long AIO, 100 USDC margin",
  thesis: "AIO is up 84% today and clearly going to flip the market — getting in before it 10x's. No reason it stops here.",
  reasoning: "Single-factor momentum chase. No invalidation level. Parabolic micro-cap. Maximal leverage on a hunch.",
  highStakes: true,
};

async function run(label: string, verdict: Verdict, decision: TradeDecision, mkt: MarketSnapshot) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`${label}`);
  console.log(`  Decision: ${decision.action}`);
  console.log(`  Thesis:   "${decision.thesis}"`);
  console.log(`  ThoughtProof verdict (simulated for demo): ${verdict}`);
  const res = await executeViaMetaMask(verdict, decision, mkt);
  console.log(`  → MetaMask executor: [${res.mode}/${res.status}]`);
  console.log(`  → ${res.note}`);
  if (res.command) {
    console.log(`  → mm command ${res.status === "blocked-before-mm" ? "that was SUPPRESSED" : "built"}: ${res.command.pretty}`);
  }
  if (res.output) {
    console.log(`  → mm output: ${res.output.slice(0, 400)}`);
  }
  return res;
}

async function main() {
  const mode = getExecutionMode();
  console.log("ThoughtProof × MetaMask Agent Wallet — integration demo");
  console.log(`MM_EXECUTION_MODE = ${mode}${mode === "off" ? "  ⚠️  set MM_EXECUTION_MODE=dryrun to exercise the integration" : ""}`);
  const mm = await probeMm();
  console.log(`mm CLI: ${mm.available ? "installed" : "NOT installed"}${mm.available ? (mm.authed ? ", logged in" : ", NOT logged in (run `mm login`)") : ""}`);

  // The ALLOW case: a defensible trade is permitted → mm command is built/quoted.
  const allowed = await run("CASE 1 — DEFENSIBLE DECISION (verifier ALLOWs)", "ALLOW", goodDecision, market("ETHUSDT", 3210));

  // The BLOCK case: an indefensible trade → mm is never touched. THE HEADLINE.
  const blocked = await run("CASE 2 — INDEFENSIBLE DECISION (verifier BLOCKs)", "BLOCK", badDecision, market("AIOUSDT", 0.2248, { priceChangePct24h: 84.5 }));

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log("SUMMARY — what this proves");
  console.log(`  • ALLOW path  → mm was ${allowed.status === "blocked-before-mm" ? "NOT touched (unexpected!)" : `engaged (${allowed.status})`}.`);
  console.log(`  • BLOCK path  → mm.status = "${blocked.status}". The transaction ${blocked.status === "blocked-before-mm" ? "NEVER entered MetaMask's pipeline." : "leaked through (BUG)."}`);
  console.log(`  • ThoughtProof sits at Layer 5 (decision quality), one layer above MetaMask's`);
  console.log(`    Layer 2/3 (execution + Blockaid security). Zero changes to MetaMask required —`);
  console.log(`    the gate lives in the agent that drives the wallet.`);

  // Exit non-zero if the core invariant is violated (BLOCK must suppress mm).
  if (blocked.status !== "blocked-before-mm") {
    console.error("\n❌ INVARIANT VIOLATED: a BLOCKed decision did not suppress the mm call.");
    process.exit(1);
  }
  console.log("\n✅ Invariant holds: BLOCK suppresses execution before MetaMask is ever called.");
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
