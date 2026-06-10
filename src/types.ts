// Shared types for the verified trading agent.

export type Verdict = "ALLOW" | "BLOCK" | "UNCERTAIN";

/** A live market snapshot the agent reasons over. */
export interface MarketSnapshot {
  symbol: string; // e.g. "BTCUSDT"
  price: number;
  priceChangePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fetchedAt: string; // ISO
}

/** The agent's trade decision (from Kimi K2.6). */
export interface TradeDecision {
  symbol: string;
  /** Human-readable intended action, e.g. "open 5x long BTC, 8000 USDC margin" */
  action: string;
  /** Direction the agent wants to take. */
  side: "long" | "short" | "flat";
  /** Notional / leverage descriptor for stake classification. */
  leverage: number;
  /** The one-line decisive thesis (Kimi message.content). */
  thesis: string;
  /** The full reasoning chain (Kimi message.reasoning_content) — what we verify. */
  reasoning: string;
  /** Whether this is a high-stakes decision (routes to RV) or routine (Sentinel only). */
  highStakes: boolean;
}

/** Result from a ThoughtProof verification (Sentinel and/or RV). */
export interface VerificationResult {
  route: "sentinel" | "rv" | "pipeline";
  finalVerdict: Verdict;
  /**
   * Fail-closed semantics: ALLOW => execute (simulated). BLOCK or UNCERTAIN => do NOT trade.
   * We never act on an unresolved verdict — uncertainty is treated conservatively.
   */
  sentinel?: {
    verdict: Verdict;
    confidence: number;
    reason: string;
    /** Cryptographic proof from Sentinel — the evidence anchor for the block/allow. */
    attestation?: {
      prepared?: boolean;
      issued?: boolean;
      schemaUid?: string;
      claimHash?: string;
      evidenceHash?: string;
    };
  };
  rv?: {
    verdict: Verdict;
    confidence: number;
    summary: string;
    objections: Array<{
      severity: "low" | "medium" | "high" | "critical";
      explanation: string;
    }>;
    /** RV verification profile + model count (from /v1/check). */
    modelCount?: number;
    profile?: string;
    attestation?: {
      type: string;
      hash?: string;
      signature?: string;
      receiptId?: string;
    };
  };
  latencyMs: number;
}

import type { EnrichmentResults } from "./enrichments.js";

/** One full decision cycle, persisted to the tracking log. */
export interface DecisionRecord {
  timestamp: string; // ISO
  cycle: number;
  market: MarketSnapshot;
  decision: TradeDecision;
  verification: VerificationResult;
  /** What actually happened given the verdict. */
  outcome: "EXECUTED" | "BLOCKED" | "SKIPPED";
  /** Whether the decision was a flat/no-op (agent chose not to trade). */
  noTrade: boolean;
  /** pot-sdk enrichments (polymarket, friend, graph, pay). */
  enrichments?: EnrichmentResults;
}
