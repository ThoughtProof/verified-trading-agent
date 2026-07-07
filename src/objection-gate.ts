// Objection-binding re-plan gate for the VTA.
//
// Wires the shared predicate logic (@thoughtproof/fact-check-core/objection-predicate)
// into the VTA replan loop: at HOLD it authors a falsifiable predicate from each
// numeric structural flag of the ORIGINAL decision; at RESOLVE it MEASURES the
// revised decision's value from the SAME market snapshot (never the agent's revised
// text) and applies the deterministic boolean gate.
//
// Honest boundary (held, not softened): this closes the ASSERTION gap — the agent
// cannot hand us a number, the value is measured from the data source. It does NOT
// close the timing gap (the agent still chooses moment/asset). Phrasing stays
// "measured from the data source, not asserted by the agent" — never "agent-independent".
//
// Only the three numeric classes (direction/magnitude/range_position) are gated.
// Fuzzy objections are not represented here — they stay with fresh Sentinel judgment.

import type { TradeDecision, MarketSnapshot } from "./types.js";
import { structuralCheckFull } from "./structural-check.js";

export interface ObjectionGateResult {
  checked: Array<{
    kind: "direction" | "magnitude" | "range_position";
    satisfied: boolean;
    reason: string;
  }>;
  allSatisfied: boolean;
}

/**
 * Run the objection-binding gate for a re-plan.
 *
 * Semantics (corrected after steelman 2026-07-07): the gate asks "did the REVISION
 * stop making the claim the data refuted?" — NOT "does the market fact equal itself"
 * (which is tautologically true on a frozen snapshot). Concretely: for each numeric
 * objection the HOLD raised, we re-run the deterministic structural check on the
 * REVISED decision against the SAME snapshot. If the revision no longer raises that
 * objection class, it dropped the refuted claim → satisfied. If it still raises it
 * (still claims something the measured fact contradicts) → not satisfied.
 *
 * Federico's line held: the fact (actualValue) is MEASURED from the snapshot, never
 * asserted by the agent. What the revision supplies is only its CLAIM; the gate
 * compares that claim against the measured fact via the same fact-checker. The agent
 * cannot pass by asserting a number — it passes only by no longer contradicting the
 * measured data.
 *
 * @param original  the HOLD decision (which numeric objection classes it raised)
 * @param revised   the revised decision (re-checked against the snapshot)
 * @param market    the frozen snapshot both were reasoned against
 *
 * Returns null when the HOLD carried no numeric (predicate-gated) objection.
 */
export function runObjectionGate(
  original: TradeDecision,
  revised: TradeDecision,
  market: MarketSnapshot,
): ObjectionGateResult | null {
  const holdFlags = structuralCheckFull(original, market).flags;
  const holdKinds = new Set(
    holdFlags
      .filter((f) => f.kind === "direction" || f.kind === "magnitude" || f.kind === "range_position")
      .map((f) => f.kind),
  );
  if (holdKinds.size === 0) return null;

  // Re-run the SAME deterministic check on the REVISED decision, same snapshot.
  // The fact (actualValue) is measured from the snapshot; the revision only
  // supplies its claim, which the checker compares against that measured fact.
  const revisedFlags = structuralCheckFull(revised, market).flags;
  const revisedKindsStillFlagged = new Set(revisedFlags.map((f) => f.kind));

  const checked: ObjectionGateResult["checked"] = [];
  for (const kind of holdKinds) {
    const stillFlagged = revisedKindsStillFlagged.has(kind);
    // Responsive if the revision NO LONGER raises this objection class — i.e. it
    // dropped the claim the measured data refuted.
    const satisfied = !stillFlagged;
    const revFlag = revisedFlags.find((f) => f.kind === kind);
    checked.push({
      kind,
      satisfied,
      reason: satisfied
        ? `revision no longer raises ${kind} against the measured fact → responsive`
        : `revision still raises ${kind} (${revFlag?.evidenceLine ?? "claim contradicts measured fact"}) → not responsive`,
    });
  }

  return { checked, allSatisfied: checked.every((c) => c.satisfied) };
}
