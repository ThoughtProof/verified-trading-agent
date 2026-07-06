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
import { fetchMarketSnapshot, describeMarket, scanUniverse, scanDexUniverse, fetchDexSnapshot } from "./signal.js";
import type { ScanCandidate, DexPool } from "./signal.js";
import { generateTradeDecision, replanAfterBlock, ACTIVE_PERSONA } from "./reasoning.js";
import { verifyDecision } from "./verification.js";
import { recordDecision, computeStats, readDecisions, LOG_PATH } from "./tracking.js";
import { ReputationWriter } from "./reputation.js";
import { runEnrichments, logEnrichments } from "./enrichments.js";
import { executeViaMetaMask, getExecutionMode, type ExecutionResult } from "./metamask-executor.js";
import type { DecisionRecord, MarketSnapshot } from "./types.js";

const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY ?? "";
const THOUGHTPROOF_API_KEY = process.env.THOUGHTPROOF_API_KEY ?? "";
// Active discovery (default ON): each cycle scans the whole Binance USDT universe
// for relative strength + breakout structure, then reasons about the strongest
// candidates — what a real desk does. Set SCAN_ENABLED=false to fall back to the
// static SYMBOLS basket below.
const SCAN_ENABLED = (process.env.SCAN_ENABLED ?? "true").toLowerCase() !== "false";
const SCAN_MIN_VOLUME_USD = Number(process.env.SCAN_MIN_VOLUME_USD ?? 10_000_000);
const SCAN_TOP_N = Number(process.env.SCAN_TOP_N ?? 8);
// DEX discovery (default ON): mix in trending on-chain pools (GeckoTerminal) —
// where the real degen money and the real danger live (thin liquidity, fresh
// pools, rugs). The tempting outsized gains autonomous agents chase. DEX_EVERY_N
// = on every Nth cycle, evaluate a DEX token instead of a CEX one (default 3, so
// roughly 1 in 3 cycles probes the on-chain tail). Set DEX_ENABLED=false to skip.
const DEX_ENABLED = (process.env.DEX_ENABLED ?? "true").toLowerCase() !== "false";
const DEX_EVERY_N = Math.max(1, Number(process.env.DEX_EVERY_N ?? 3));
const DEX_MIN_LIQUIDITY_USD = Number(process.env.DEX_MIN_LIQUIDITY_USD ?? 250_000);
const DEX_MIN_VOLUME_USD = Number(process.env.DEX_MIN_VOLUME_USD ?? 500_000);
const DEX_TOP_N = Number(process.env.DEX_TOP_N ?? 6);
// Fallback basket (used when SCAN_ENABLED=false, or if a scan returns nothing).
// The agent evaluates one symbol per cycle, rotating through the list. SYMBOLS
// (comma-list) wins; falls back to legacy single SYMBOL; defaults to major-caps.
const SYMBOLS: string[] = (process.env.SYMBOLS ?? process.env.SYMBOL ?? "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s.length > 0);
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

/**
 * Pick + fetch the market to evaluate this cycle, returning a ready snapshot.
 *
 * Every DEX_EVERY_N-th cycle (when DEX_ENABLED) probes the on-chain tail:
 * discover trending DEX pools, pick one of the top movers, fetch its OHLCV
 * snapshot. Otherwise scans the Binance universe for relative strength and
 * rotates through the top-N. Falls back to the static SYMBOLS basket if a scan
 * fails or returns nothing — the loop must never starve.
 */
async function selectMarket(cycle: number): Promise<MarketSnapshot> {
  // ── DEX cycle: probe the on-chain tail ──────────────────────────────────────
  if (DEX_ENABLED && cycle % DEX_EVERY_N === 0) {
    try {
      const pools: DexPool[] = await scanDexUniverse(DEX_MIN_LIQUIDITY_USD, DEX_MIN_VOLUME_USD, DEX_TOP_N);
      if (pools.length > 0) {
        console.log(`🜲 DEX scan — trending on-chain (liq ≥$${(DEX_MIN_LIQUIDITY_USD / 1e3).toFixed(0)}k, vol ≥$${(DEX_MIN_VOLUME_USD / 1e3).toFixed(0)}k):`);
        const pick = (cycle / DEX_EVERY_N - 1) % pools.length;
        pools.forEach((p, i) =>
          console.log(
            `   ${i === pick ? "→" : " "} ${p.name.padEnd(22)} ${p.changePct24h >= 0 ? "+" : ""}${p.changePct24h.toFixed(1)}%  vol $${(p.volumeUsd24h / 1e3).toFixed(0)}k  liq $${(p.liquidityUsd / 1e3).toFixed(0)}k  ${p.network}/${p.dexId}`,
          ),
        );
        return await fetchDexSnapshot(pools[pick]);
      }
      console.warn("⚠️  DEX scan returned no pools above floors — falling back to CEX scan.");
    } catch (err) {
      console.error(`⚠️  DEX scan failed (${err instanceof Error ? err.message : err}) — falling back to CEX scan.`);
    }
  }

  // ── CEX cycle: scan the Binance universe ────────────────────────────────────
  if (SCAN_ENABLED) {
    try {
      const candidates: ScanCandidate[] = await scanUniverse(SCAN_MIN_VOLUME_USD, SCAN_TOP_N);
      if (candidates.length > 0) {
        console.log(`🔭 Universe scan — top movers (≥$${(SCAN_MIN_VOLUME_USD / 1e6).toFixed(0)}M vol):`);
        candidates.forEach((c, i) =>
          console.log(
            `   ${i === (cycle - 1) % candidates.length ? "→" : " "} ${c.symbol.padEnd(13)} ${c.changePct24h >= 0 ? "+" : ""}${c.changePct24h.toFixed(2)}%  vol $${(c.quoteVolumeUsd / 1e6).toFixed(0)}M  rangePos ${(c.rangePosition * 100).toFixed(0)}%`,
          ),
        );
        return await fetchMarketSnapshot(candidates[(cycle - 1) % candidates.length].symbol);
      }
      console.warn("⚠️  Scan returned no liquid candidates — falling back to basket.");
    } catch (err) {
      console.error(`⚠️  Universe scan failed (${err instanceof Error ? err.message : err}) — falling back to basket.`);
    }
  }
  return await fetchMarketSnapshot(SYMBOLS[(cycle - 1) % SYMBOLS.length]);
}

async function runCycle(cycle: number, market: MarketSnapshot, reputation: ReputationWriter | null): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`\n──────── Cycle ${cycle} · ${market.symbol}${market.venue === "dex" ? " [DEX]" : ""} · ${ts} ────────`);

  // 1. Signal (already fetched by the selector — CEX ticker or DEX pool)
  console.log(`📊 ${describeMarket(market)}`);

  // 2. Reasoning (Kimi K2.6)
  const { decision: decision0 } = await generateTradeDecision(market, MOONSHOT_API_KEY);
  if (decision0.side === "flat") {
    console.log(`🤖 Agent: stays FLAT — ${decision0.thesis}`);
  } else {
    const rvOn = (process.env.RV_ENABLED ?? "true").toLowerCase() !== "false";
    const route = !rvOn || decision0.stakeLevel === "micro" ? "Sentinel-only" : "Sentinel→RV";
    console.log(
      `🤖 Agent wants: ${decision0.action} [${decision0.side} ${decision0.leverage}x, stake=${decision0.stakeLevel} → ${route}]`,
    );
    console.log(`   Thesis: ${decision0.thesis}`);
  }

  // 3. Verification (ThoughtProof)
  // describeMarket(market) = the action-free decision situation, so RV's
  // generator panel can take independent positions before seeing our decision.
  const marketSituation = describeMarket(market);
  let decision = decision0;
  let verification = await verifyDecision(decision, THOUGHTPROOF_API_KEY, marketSituation);

  // 3b. Re-plan on a blocked directional decision (at most once).
  // Bens GOAT point: on UNCERTAIN/BLOCK the agent should do something useful —
  // revise using the objections — instead of just halting. The revised decision
  // is verified again by the same independent pipeline (no arguing past it).
  let replan: DecisionRecord["replan"];
  const firstBlocked =
    decision.side !== "flat" &&
    (verification.finalVerdict === "BLOCK" || verification.finalVerdict === "UNCERTAIN");
  if (firstBlocked) {
    // Prefer RV's objections (richest). On a Sentinel-only gate (no RV
    // escalation), use Sentinel's structured per-step objections — now that
    // /sentinel/verify exposes them — instead of the raw failScore string.
    const objections = (verification.rv?.objections ?? []).map((o) => o.explanation);
    if (objections.length === 0 && verification.sentinel?.objections?.length) {
      objections.push(...verification.sentinel.objections.map((o) => o.explanation));
    }
    if (objections.length === 0 && verification.sentinel?.reason) {
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
      const revisedVerification = await verifyDecision(revised.decision, THOUGHTPROOF_API_KEY, marketSituation);

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

  // 4b. MetaMask Agent Wallet integration (Layer 5 → Layer 2).
  // For any directional decision we run the executor. On ALLOW it builds (and,
  // if mm is installed+authed, validates via read-only `mm perps quote`) the
  // real command. On BLOCK/UNCERTAIN it proves the headline: `mm` is NEVER
  // invoked — the transaction never enters MetaMask's pipeline. No-op when
  // MM_EXECUTION_MODE=off (default), so existing behaviour is unchanged.
  let metamask: ExecutionResult | undefined;
  if (!noTrade && getExecutionMode() !== "off") {
    metamask = await executeViaMetaMask(verification.finalVerdict, decision, market);
    console.log(`   🦊 MetaMask [${metamask.mode}/${metamask.status}]: ${metamask.note}`);
    if (metamask.output) {
      console.log(`      ↳ mm output: ${metamask.output.slice(0, 300)}${metamask.output.length > 300 ? "…" : ""}`);
    }
  }

  // 5. pot-sdk enrichments (polymarket crowd-intel, friend memory, graph)
  const enrichments = await runEnrichments(decision, verification);
  logEnrichments(enrichments);

  // 6. Track
  const record: DecisionRecord = {
    timestamp: ts,
    cycle,
    market,
    decision,
    verification,
    outcome,
    noTrade,
    replan,
    enrichments,
    metamask: metamask
      ? {
          mode: metamask.mode,
          allowed: metamask.allowed,
          status: metamask.status,
          note: metamask.note,
          command: metamask.command ? { pretty: metamask.command.pretty, args: metamask.command.args } : null,
          output: metamask.output,
        }
      : undefined,
  };
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
  console.log(`Persona: ${ACTIVE_PERSONA.toUpperCase()}`);
  console.log(
    SCAN_ENABLED
      ? `Mode: ${once ? "single cycle" : "loop"} · Discovery: CEX universe scan (top ${SCAN_TOP_N}, ≥$${(SCAN_MIN_VOLUME_USD / 1e6).toFixed(0)}M vol)${DEX_ENABLED ? ` + DEX probe every ${DEX_EVERY_N} cycles (liq ≥$${(DEX_MIN_LIQUIDITY_USD / 1e3).toFixed(0)}k)` : ""} · Fallback: ${SYMBOLS.join(",")} · Log: ${LOG_PATH}`
      : `Mode: ${once ? "single cycle" : "loop"} · Symbols: ${SYMBOLS.join(", ")} (rotating, scan OFF) · Log: ${LOG_PATH}`,
  );
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
    // Single-cycle mode: discover (or fall back to) one market and evaluate it.
    const market = await selectMarket(cycle);
    await runCycle(cycle, market, reputation);
  } else {
    while (true) {
      // Each cycle: discover + fetch the market (DEX probe or CEX scan), then evaluate.
      try {
        const market = await selectMarket(cycle);
        await runCycle(cycle, market, reputation);
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
