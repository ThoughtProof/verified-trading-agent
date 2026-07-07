// Shared types for the verified trading agent.

export type Verdict = "ALLOW" | "BLOCK" | "UNCERTAIN";

/**
 * RV verdict threshold + routing level. Higher stake demands higher reasoning
 * soundness to ALLOW (micro 0.40 → critical 0.85). Mirrors the canonical
 * cb4a-verify contract so both agents share one escalation model.
 * "micro" runs the fast Sentinel-only gate; everything else escalates to the
 * full Sentinel→RV adversarial pipeline.
 */
export type StakeLevel = "micro" | "low" | "medium" | "high" | "critical";

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
  symbol: string; // e.g. "BTCUSDT" (CEX) or "PEPE/WETH" (DEX pool)
  price: number;
  priceChangePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  fetchedAt: string; // ISO
  /** Multi-day technical context (trend, SMA, RSI, candle structure). */
  technicals?: Technicals;
  /** Trading venue. "cex" = Binance spot (full daily history). "dex" = on-chain
   * pool via GeckoTerminal (hourly OHLCV; thinner history, higher rug/liquidity
   * risk). DEX context is intentionally flagged so the agent + verifier + the
   * block-log can treat it with appropriate skepticism. */
  venue?: "cex" | "dex";
  /** DEX-only context (present when venue === "dex"): on-chain risk signals. */
  dex?: {
    network: string;          // e.g. "solana", "eth", "base"
    dexId: string;            // e.g. "raydium", "uniswap_v3"
    poolAddress: string;
    liquidityUsd: number;     // total pool reserve — thin = untradeable / rug-prone
    /** Hours of OHLCV history actually available (DEX tokens can be brand new). */
    historyHours: number;
  };
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
  /**
   * Stake level driving the RV verdict threshold + routing (micro→critical).
   * Derived from leverage AND notional, so a large unleveraged directional bet
   * escalates too (not just 3x+ leverage). "micro" = Sentinel-only fast gate.
   */
  stakeLevel: StakeLevel;
}

/** Result from a ThoughtProof verification (Sentinel and/or RV). */
export interface VerificationResult {
  route: "sentinel" | "rv" | "pipeline" | "structural";
  finalVerdict: Verdict;
  /**
   * Fail-closed semantics: ALLOW => execute (simulated). BLOCK or UNCERTAIN => do NOT trade.
   * We never act on an unresolved verdict — uncertainty is treated conservatively.
   */
  sentinel?: {
    verdict: Verdict;
    confidence: number;
    reason: string;
    /**
     * Structured per-step objections from Sentinel /sentinel/verify (added
     * 2026-06-14): gold-step criterion, predicate, score, quote + a
     * human-readable reasoning sentence. The actionable substance behind a
     * Sentinel gate — fed to the agent on a Sentinel-only block/replan.
     */
    objections: Array<{
      severity: "low" | "medium" | "high" | "critical";
      explanation: string;
    }>;
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
      /** Ethereum address that signed the proof (verify via ecrecover / GET /v1/signer). */
      signer?: string;
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
    /** Objection-binding gate result (numeric-class objections only): for each
     *  predicate-gated objection from the HOLD, whether the revised plan's
     *  independently-MEASURED value satisfies it. Absent when no numeric objection
     *  was present. The measured value comes from the fact-checker (same snapshot),
     *  never from the agent's revised text. Fuzzy objections stay with fresh judgment. */
    objectionGate?: {
      checked: Array<{
        kind: "direction" | "magnitude" | "range_position";
        satisfied: boolean;
        reason: string;
      }>;
      /** true only if ALL predicate-gated objections are satisfied by measured values. */
      allSatisfied: boolean;
    };
  };
  /** pot-sdk enrichments (polymarket, friend, graph, pay). */
  enrichments?: EnrichmentResults;
  /**
   * MetaMask Agent Wallet execution trail (present when MM_EXECUTION_MODE != off
   * and the decision was directional). Records whether `mm` was invoked, the
   * exact command, and the outcome — the proof that BLOCKED decisions never
   * reach MetaMask's pipeline. Typed loosely here to avoid a circular import
   * with metamask-executor.ts; the full ExecutionResult shape is serialized.
   */
  metamask?: {
    mode: "off" | "dryrun" | "live";
    allowed: boolean;
    status: string;
    note: string;
    command: { pretty: string; args: string[] } | null;
    output: string | null;
  };
}
