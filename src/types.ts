// Shared types for the verified trading agent.

export type Verdict = "ALLOW" | "BLOCK" | "UNCERTAIN";

/** Multi-day technical indicators computed from daily klines. */
export interface Technicals {
  /** % change over the last 7 daily closes */
  change7dPct: number;
  /** % change over the last 14 daily closes */
  change14dPct: number;
  /** 7-day simple moving average */
  sma7: number;
  /** 30-day simple moving average */
  sma30: number;
  /** Current price relative to SMA7 */
  vsSma7: "above" | "below";
  /** Current price relative to SMA30 */
  vsSma30: "above" | "below";
  /** 14-day RSI (0-100). >70 overbought, <30 oversold. */
  rsi14: number;
  /** Consecutive same-direction daily closes (+ up streak, - down streak) */
  consecutiveCloses: number;
  /** Trend label derived from SMA structure + multi-day change */
  trend: "strong_uptrend" | "uptrend" | "ranging" | "downtrend" | "strong_downtrend";
}

/** A live market snapshot the agent reasons over. */
export interface MarketSnapshot {
  symbol: string; // e.g. "BTCUSDT"
  price: number;
  priceChangePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fetchedAt: string; // ISO
  /** Multi-day technical context (trend, SMA, RSI, candle structure). */
  technicals?: Technicals;
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

// ─── Enrichment Types (kept here to avoid circular import with enrichments.ts) ─

/** Results from all pot-sdk enrichments for one decision cycle. */
export interface EnrichmentResults {
  /** Full Polymarket enrichment result. Typed as Record to avoid importing
   *  @pot-sdk2/polymarket in the core types file — the actual PolymarketEnrichment
   *  type is used in enrichments.ts. The JSONL serializes the full object. */
  polymarket?: {
    available: boolean;
    modifiesVerdict: boolean;
    verdictAdjustment: "strengthen" | "weaken" | "flag" | "none";
    contextForSynthesis: string;
    result?: {
      primarySignal?: {
        probability: number;
        strength: string;
        market: { question: string };
      } | null;
      alignment?: string;
      collectiveConfidence?: number;
    } | null;
  };
  friend?: { critique: string; recurring: boolean; sessionId: string } | null;
  graph?: { contradictions: number; critique: string } | null;
}

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
  /**
   * Re-plan trail. Present when the first decision was BLOCK/UNCERTAIN and the
   * agent was given one chance to revise using the verifier's objections.
   * `decision` and `verification` above always reflect the FINAL attempt.
   */
  replan?: {
    /** The original blocked decision + its verdict (what triggered the re-plan). */
    original: { decision: TradeDecision; verification: VerificationResult };
    /** How the revision resolved: did the agent stand down, size down, or still get blocked? */
    resolution: "flat" | "revised-allowed" | "revised-blocked";
  };
  /** pot-sdk enrichments (polymarket, friend, graph, pay). */
  enrichments?: EnrichmentResults;
}
