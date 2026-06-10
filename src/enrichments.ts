// pot-sdk enrichment layer for the verified trading agent.
//
// Integrates all 5 pot-sdk packages into the verification pipeline:
//   1. polymarket — crowd-intelligence calibration (pre-verification)
//   2. friend — persistent memory critic (post-verification)
//   3. graph — knowledge-graph contradiction detection (post-verification)
//   4. pay — x402 payment verification (future, when x402 is live)
//
// Each enrichment is:
// - Non-blocking: failure of any enrichment does not affect the core loop
// - Logged: results are appended to the DecisionRecord for the trust record
// - Honest: if no data is available (e.g. no PM markets), we say so

import { enrichVerification, DEFAULT_CONFIG } from "@pot-sdk2/polymarket";
import type { PolymarketEnrichment } from "@pot-sdk2/polymarket";
import type { TradeDecision, VerificationResult } from "./types.js";

// ─── Enrichment Results (appended to DecisionRecord) ──────────────────────────

export interface EnrichmentResults {
  polymarket?: PolymarketEnrichment;
  /** Future enrichments (friend, graph, pay) go here */
  friend?: { critique: string; recurring: boolean; sessionId: string } | null;
  graph?: { contradictions: number; critique: string } | null;
}

// ─── Polymarket Enrichment ────────────────────────────────────────────────────

/**
 * Query Polymarket for crowd-intelligence relevant to the trade decision.
 * Returns enrichment data or null on failure (non-fatal).
 */
export async function enrichWithPolymarket(
  decision: TradeDecision,
): Promise<PolymarketEnrichment | null> {
  try {
    // Use keyword search — we don't have a specific Polymarket conditionId
    // for BTC price direction. The package handles "no data" gracefully.
    const claim = `${decision.action}. Thesis: ${decision.thesis}`;
    const enriched = await enrichVerification(
      {
        claim,
        modelVerdict: "ALLOW", // We haven't verified yet — pass ALLOW as baseline
        modelConfidence: 0.5, // Neutral prior
        stakeLevel: decision.highStakes ? "high" : "medium",
      },
      {
        ...DEFAULT_CONFIG,
        timeout: 8_000, // 8s timeout — don't let PM API hang the loop
        fetchOrderBook: false, // Skip CLOB for speed
      },
    );
    return enriched;
  } catch (err) {
    console.error(
      `  ⚠️ Polymarket enrichment failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ─── Log enrichment results to console ────────────────────────────────────────

export function logEnrichments(results: EnrichmentResults): void {
  // Polymarket
  if (results.polymarket) {
    const pm = results.polymarket;
    if (pm.available && pm.result?.primarySignal) {
      const signal = pm.result.primarySignal;
      const pct = (signal.probability * 100).toFixed(1);
      const adj = pm.verdictAdjustment;
      console.log(
        `   📊 Polymarket: "${signal.market.question}" → ${pct}% YES, ${signal.strength} signal, adjustment: ${adj}`,
      );
      if (pm.result.alignment !== "neutral") {
        console.log(
          `      Alignment: ${pm.result.alignment} (composite confidence: ${(pm.result.collectiveConfidence * 100).toFixed(1)}%)`,
        );
      }
    } else {
      console.log(
        `   📊 Polymarket: no relevant prediction markets found`,
      );
    }
  }

  // Friend
  if (results.friend) {
    const f = results.friend;
    if (f.recurring) {
      console.log(
        `   🧠 Friend: RECURRING pattern detected — "${f.critique}"`,
      );
    } else {
      console.log(`   🧠 Friend: ${f.critique}`);
    }
  }

  // Graph
  if (results.graph) {
    const g = results.graph;
    if (g.contradictions > 0) {
      console.log(
        `   🕸️ Graph: ${g.contradictions} contradiction(s) — "${g.critique}"`,
      );
    } else {
      console.log(`   🕸️ Graph: consistent, no contradictions`);
    }
  }
}

// ─── Run all enrichments ──────────────────────────────────────────────────────

/**
 * Run all available pot-sdk enrichments for a trade decision.
 * Called AFTER verification but BEFORE tracking (so results go into the JSONL).
 *
 * Enrichments are independent and non-blocking — each failing silently
 * doesn't affect others or the core loop.
 */
export async function runEnrichments(
  decision: TradeDecision,
  _verification: VerificationResult,
): Promise<EnrichmentResults> {
  const results: EnrichmentResults = {};

  // 1. Polymarket — crowd intelligence (no API key needed, public APIs)
  results.polymarket = (await enrichWithPolymarket(decision)) ?? undefined;

  // 2. Friend — persistent memory critic
  // Requires LLM provider. Left as hook for Phase 2+ when we add FRIEND_LLM_KEY.
  // The integration point: after N cycles, Friend remembers repeated weak theses
  // and escalates ("3rd time BTC dip-buying with leverage — maybe reconsider").
  results.friend = null;

  // 3. Graph — knowledge graph contradiction detection
  // Requires LLM for entity extraction. Left as hook for Phase 2+.
  results.graph = null;

  // 4. Pay — x402 payment verification
  // Activates when agent actually executes x402 payments. Not relevant for
  // simulated execution. Left as hook for Phase 3 (live trading).

  return results;
}
