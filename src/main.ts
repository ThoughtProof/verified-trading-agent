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
import { generateTradeDecision, replanAfterBlock } from "./reasoning.js";
import { verifyDecision } from "./verification.js";
import { recordDecision, computeStats, readDecisions, LOG_PATH } from "./tracking.js";
import { ReputationWriter } from "./reputation.js";
import { runEnrichments, logEnrichments } from "./enrichments.js";
import type { DecisionRecord } from "./types.js";

const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY ?? "";
const THOUGHTPROOF_API_KEY = process.env.THOUGHTPROOF_API_KEY ?? "";
const SYMBOL = process.env.SYMBOL ?? "BTCUSDT";
const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? 0);
const CYCLE_INTERVAL_SEC = Number(process.env.CYCLE_INTERVAL_SEC ?? 900);
const PRIVATE_KEY = process.env.REPUTATION_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";

function requireKeys(): void {
  const missing: string[] = [];
  if (!MOONSHOT_API_KEY) missing.push("MOONSHOT_API_KEY");
  if (!THOUGHTPROOF_API_KEY) missing.push("THOUGHTPROOF_API_KEY");
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill in.`);
    process.exit(1);
  }
}

/** Build a ReputationWriter if PRIVATE_KEY + AGENT_ID are configured, else null. */
function initReputation(): ReputationWriter | null {
  if (!PRIVATE_KEY || !AGENT_ID) {
    console.log("⚠️  PRIVATE_KEY or AGENT_ID not set — on-chain reputation writes disabled.");
    return null;
  }
  return new ReputationWriter({
    privateKey: PRIVATE_KEY,
    agentId: BigInt(AGENT_ID),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCycle(cycle: number, reputation: ReputationWriter | null): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n──────── Cycle ${cycle} · ${ts} ────────`);

  // 1. Signal
  const market = await fetchMarketSnapshot(SYMBOL);
  console.log(`📊 ${describeMarket(market)}`);

  // 2. Reasoning (Kimi K2.6)
  const { decision: decision0 } = await generateTradeDecision(market, MOONSHOT_API_KEY);
  if (decision0.side === "flat") {
    console.log(`🤖 Agent: stays FLAT — ${decision0.thesis}`);
  } else {
    console.log(
      `🤖 Agent wants: ${decision0.action} [${decision0.side} ${decision0.leverage}x, ${decision0.highStakes ? "HIGH-STAKES→RV" : "routine→Sentinel"}]`,
    );
    console.log(`   Thesis: ${decision0.thesis}`);
  }

  // 3. Verification (ThoughtProof)
  let decision = decision0;
  let verification = await verifyDecision(decision, THOUGHTPROOF_API_KEY);

  // 3b. Re-plan on a blocked directional decision (at most once).
  // Bens GOAT point: on UNCERTAIN/BLOCK the agent should do something useful —
  // revise using the objections — instead of just halting. The revised decision
  // is verified again by the same independent pipeline (no arguing past it).
  let replan: DecisionRecord["replan"];
  const firstBlocked =
    decision.side !== "flat" &&
    (verification.finalVerdict === "BLOCK" || verification.finalVerdict === "UNCERTAIN");
  if (firstBlocked) {
    const objections = (verification.rv?.objections ?? []).map((o) => o.explanation);
    if (verification.sentinel?.reason && objections.length === 0) {
      objections.push(verification.sentinel.reason);
    }
    console.log(`↻ Re-planning after ${verification.finalVerdict} — feeding objections back to the agent...`);
    try {
      const original = { decision, verification };
      const revised = await replanAfterBlock(
        market,
        decision,
        verification.finalVerdict as "BLOCK" | "UNCERTAIN",
        objections,
        MOONSHOT_API_KEY,
      );
      // Verify the revised decision (flat is a no-op trade but still recorded
      // as ALLOW by verifyDecision, so the resolution reads correctly).
      const revisedVerification = await verifyDecision(revised.decision, THOUGHTPROOF_API_KEY);

      const resolution: NonNullable<DecisionRecord["replan"]>["resolution"] =
        revised.decision.side === "flat"
          ? "flat"
          : revisedVerification.finalVerdict === "ALLOW"
            ? "revised-allowed"
            : "revised-blocked";

      console.log(
        `   → revised: ${revised.decision.side === "flat" ? "STOOD DOWN (flat)" : `${revised.decision.side} ${revised.decision.leverage}x`} ` +
          `→ ${revisedVerification.finalVerdict} [${resolution}]`,
      );

      // The FINAL attempt becomes the record's decision/verification.
      decision = revised.decision;
      verification = revisedVerification;
      replan = { original, resolution };
    } catch (err) {
      console.error(`   ⚠️  Re-plan failed (keeping original block): ${err instanceof Error ? err.message : err}`);
    }
  }

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
    console.log(`🛑 ${verification.finalVerdict} (${verification.route}) — trade NOT sent [fail-closed]`);
    console.log(`   Why: ${why}`);
    if (verification.rv?.objections?.length) {
      for (const o of verification.rv.objections.slice(0, 3)) {
        console.log(`   • [${o.severity}] ${o.explanation}`);
      }
    } else if (verification.rv) {
      console.log(`   RV: ${verification.rv.verdict} (${verification.rv.modelCount ?? "?"} models, profile ${verification.rv.profile ?? "?"})`);
    }
    // The cryptographic proof — the evidence anchor for this block.
    const att = verification.sentinel?.attestation;
    if (att?.claimHash) {
      console.log(`   🔏 Sentinel attestation: claim ${att.claimHash.slice(0, 18)}… evidence ${(att.evidenceHash ?? "").slice(0, 18)}… (schema ${(att.schemaUid ?? "").slice(0, 12)}…)`);
    }
  }

  // 5. pot-sdk enrichments (polymarket crowd-intel, friend memory, graph)
  const enrichments = await runEnrichments(decision, verification);
  logEnrichments(enrichments);

  // 6. Track
  const record: DecisionRecord = { timestamp: ts, cycle, market, decision, verification, outcome, noTrade, replan, enrichments };
  recordDecision(record);

  // 7. On-chain reputation (ERC-8004 giveFeedback, SKALE testnet — zero gas)
  if (reputation) {
    try {
      const txHash = await reputation.writeFeedback(record);
      if (txHash) {
        console.log(`🔗 On-chain: feedback written → ${txHash.slice(0, 18)}…`);
      }
    } catch (err) {
      // Non-fatal: the core loop must not break because of chain issues.
      console.error(`⚠️  On-chain write failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main(): Promise<void> {
  requireKeys();
  const once = process.argv.includes("--once");
  const reputation = initReputation();

  console.log("Verified Trading Agent — Kimi K2.6 reasons, ThoughtProof verifies.");
  console.log(`Symbol: ${SYMBOL} · Mode: ${once ? "single cycle" : "loop"} · Log: ${LOG_PATH}`);
  if (reputation) {
    const check = await reputation.verifyAgent();
    if (check.exists) {
      console.log(`🔗 ERC-8004 Agent #${reputation.agentId} confirmed (owner: ${check.owner?.slice(0, 10)}…) — reputation writes ON`);
    } else {
      console.error(`❌ Agent #${reputation.agentId} not found on-chain. Run: npx tsx scripts/register-agent.ts`);
      process.exit(1);
    }
  }

  let cycle = 1;
  const startCount = readDecisions().length;
  cycle = startCount + 1;

  if (once) {
    await runCycle(cycle, reputation);
  } else {
    while (true) {
      try {
        await runCycle(cycle, reputation);
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
