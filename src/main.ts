// Main loop — the verified trading agent.
//
// Cycle: fetch market -> Kimi K2.6 reasons -> ThoughtProof verifies ->
//        ALLOW executes (simulated) / BLOCK is logged with the receipt -> track.
//
// HONESTY LINE (non-negotiable): we do NOT promise profits. We demonstrate that
// catastrophic trades get blocked because their reasoning doesn't hold. Execution
// is always simulated; no real capital. RV judges the DEFENSIBILITY of the
// reasoning, not market direction.

import "dotenv/config";
import { fetchMarketSnapshot, describeMarket } from "./signal.js";
import { generateTradeDecision } from "./reasoning.js";
import { verifyDecision } from "./verification.js";
import { recordDecision, computeStats, readDecisions, LOG_PATH } from "./tracking.js";
import type { DecisionRecord } from "./types.js";

const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY ?? "";
const THOUGHTPROOF_API_KEY = process.env.THOUGHTPROOF_API_KEY ?? "";
const SYMBOL = process.env.SYMBOL ?? "BTCUSDT";
const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? 0);
const CYCLE_INTERVAL_SEC = Number(process.env.CYCLE_INTERVAL_SEC ?? 900);

function requireKeys(): void {
  const missing: string[] = [];
  if (!MOONSHOT_API_KEY) missing.push("MOONSHOT_API_KEY");
  if (!THOUGHTPROOF_API_KEY) missing.push("THOUGHTPROOF_API_KEY");
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill in.`);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCycle(cycle: number): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n──────── Cycle ${cycle} · ${ts} ────────`);

  // 1. Signal
  const market = await fetchMarketSnapshot(SYMBOL);
  console.log(`📊 ${describeMarket(market)}`);

  // 2. Reasoning (Kimi K2.6)
  const { decision } = await generateTradeDecision(market, MOONSHOT_API_KEY);
  if (decision.side === "flat") {
    console.log(`🤖 Agent: stays FLAT — ${decision.thesis}`);
  } else {
    console.log(
      `🤖 Agent wants: ${decision.action} [${decision.side} ${decision.leverage}x, ${decision.highStakes ? "HIGH-STAKES→RV" : "routine→Sentinel"}]`,
    );
    console.log(`   Thesis: ${decision.thesis}`);
  }

  // 3. Verification (ThoughtProof)
  const verification = await verifyDecision(decision, THOUGHTPROOF_API_KEY);

  // 4. Decide outcome
  let outcome: DecisionRecord["outcome"];
  const noTrade = decision.side === "flat";
  if (noTrade) {
    outcome = "SKIPPED";
  } else if (verification.finalVerdict === "ALLOW") {
    outcome = "EXECUTED";
    console.log(`✅ ALLOWED (${verification.route}) — trade executed [SIMULATED]`);
  } else {
    outcome = "BLOCKED";
    const why =
      verification.rv?.summary ||
      verification.rv?.objections?.[0]?.explanation ||
      verification.sentinel?.reason ||
      verification.finalVerdict;
    console.log(`🛑 ${verification.finalVerdict} (${verification.route}) — trade NOT sent`);
    console.log(`   Why: ${why}`);
    if (verification.rv?.objections?.length) {
      for (const o of verification.rv.objections.slice(0, 3)) {
        console.log(`   • [${o.severity}] ${o.explanation}`);
      }
    }
  }

  // 5. Track
  const record: DecisionRecord = { timestamp: ts, cycle, market, decision, verification, outcome, noTrade };
  recordDecision(record);
}

async function main(): Promise<void> {
  requireKeys();
  const once = process.argv.includes("--once");

  console.log("Verified Trading Agent — Kimi K2.6 reasons, ThoughtProof verifies.");
  console.log(`Symbol: ${SYMBOL} · Mode: ${once ? "single cycle" : "loop"} · Log: ${LOG_PATH}`);

  let cycle = 1;
  const startCount = readDecisions().length;
  cycle = startCount + 1;

  if (once) {
    await runCycle(cycle);
  } else {
    while (true) {
      try {
        await runCycle(cycle);
      } catch (err) {
        console.error(`Cycle ${cycle} error:`, err instanceof Error ? err.message : err);
      }
      cycle++;
      if (MAX_CYCLES > 0 && cycle - startCount > MAX_CYCLES) break;
      await sleep(CYCLE_INTERVAL_SEC * 1000);
    }
  }

  // Summary
  const stats = computeStats(readDecisions());
  console.log(`\n═══════ Run summary ═══════`);
  console.log(`Cycles: ${stats.totalCycles} · Trade attempts: ${stats.tradeAttempts}`);
  console.log(`Executed: ${stats.executed} · Blocked: ${stats.blocked} · Block rate: ${(stats.blockRate * 100).toFixed(0)}%`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
