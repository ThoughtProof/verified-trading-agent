// VTA structural check — now a THIN WRAPPER over the shared @thoughtproof/fact-check-core.
//
// Historically this file was a divergent, stripped-down port of the cb4a fact-checker
// (it kept only {kind, evidenceLine} and dropped the structured claimedValue/actualValue).
// That divergence caused real problems (the "twin round-trip" confusion, and blocked
// objection-binding which needs the structured values). This wrapper removes the
// divergence: the checking logic now lives in ONE shared library, consumed here via
// the VTA adapter. The public shape of this module is unchanged, so verification.ts
// (which reads only flags[].evidenceLine) needs no edits.
//
// Policy preserved (Steelman 2026-07-06): a direction mismatch is a SOFT flag here,
// never a hard block — the adapter converts the core's reported contradiction into a
// soft evidence flag. The reasoning layer (Sentinel trade_reasoning) makes the call.

import type { TradeDecision, MarketSnapshot } from "./types.js";
import { vtaStructuralCheck as coreVtaCheck } from "@thoughtproof/fact-check-core/adapters/vta";

/** Unchanged public shape: a soft flag carrying a `structural_fact:` evidence line.
 *  (The shared lib additionally exposes structured claimedValue/actualValue; this
 *  local type stays minimal for backwards-compatibility with existing consumers.) */
export interface VerifiedFactFlag {
  kind: "direction" | "magnitude" | "range_position";
  evidenceLine: string;
}

export interface StructuralCheckResult {
  flags: VerifiedFactFlag[];
}

/**
 * Deterministic structural check for a trade thesis. Delegates to the shared
 * fact-check-core (via the VTA adapter), then narrows to the local flag shape.
 * Pure; never throws (the core is fail-toward-silence and never throws).
 */
export function structuralCheck(decision: TradeDecision, market: MarketSnapshot): StructuralCheckResult {
  const result = coreVtaCheck(
    { thesis: decision.thesis, reasoning: decision.reasoning },
    {
      price: market.price,
      priceChangePct24h: market.priceChangePct24h,
      high24h: market.high24h,
      low24h: market.low24h,
      technicals: market.technicals ? { change7dPct: market.technicals.change7dPct } : undefined,
    },
  );
  return {
    flags: result.flags.map((f) => ({ kind: f.kind, evidenceLine: f.evidenceLine })),
  };
}

/** A full structural flag carrying the STRUCTURED values (claimedValue/actualValue),
 *  not just the evidence prose. This is what objection-binding needs to author a
 *  falsifiable predicate — the values the narrow `structuralCheck` throws away. */
export interface FullVerifiedFactFlag {
  kind: "direction" | "magnitude" | "range_position";
  claimText: string | null;
  claimedValue: number | null;
  actualValue: number | null;
  evidenceLine: string;
}

/**
 * Same deterministic check as `structuralCheck`, but returns the FULL structured
 * flags (with claimedValue/actualValue) instead of narrowing to evidence prose.
 * Used by the objection-binding re-plan gate, which needs the structured values.
 * Behaviorally identical to structuralCheck (same core call) — only the return
 * shape is richer, so nothing that uses the narrow version is affected.
 */
export function structuralCheckFull(decision: TradeDecision, market: MarketSnapshot): { flags: FullVerifiedFactFlag[] } {
  const result = coreVtaCheck(
    { thesis: decision.thesis, reasoning: decision.reasoning },
    {
      price: market.price,
      priceChangePct24h: market.priceChangePct24h,
      high24h: market.high24h,
      low24h: market.low24h,
      technicals: market.technicals ? { change7dPct: market.technicals.change7dPct } : undefined,
    },
  );
  return { flags: result.flags };
}
