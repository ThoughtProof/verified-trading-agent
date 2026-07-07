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
