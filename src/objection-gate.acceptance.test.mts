// ACCEPTANCE TEST for the objection-binding gate (corrected semantics after
// steelman 2026-07-07). The gate must actually DISCRIMINATE: a revision that drops
// the refuted claim passes; a revision that keeps it fails. If both passed
// regardless (the trivial-no-op the first version had), this test fails loudly.
//
// Federico's line held: the fact is MEASURED from the snapshot; the revision only
// supplies its claim, checked against that measured fact. The agent cannot pass by
// asserting a number — only by no longer contradicting the measured data.
//
// Run: npx vitest run src/objection-gate.acceptance.test.mts

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { runObjectionGate } from "./objection-gate.js";
import type { TradeDecision, MarketSnapshot } from "./types.js";

// Frozen snapshot: verified 24h move ~ +8%. A thesis claiming ~+8% is consistent;
// a thesis claiming +21.8% overstates it (magnitude objection).
const market: MarketSnapshot = {
  symbol: "HYPEUSDT", price: 0.0089, priceChangePct24h: 8, high24h: 0.010, low24h: 0.006,
  volume24h: 1_000_000, fetchedAt: new Date().toISOString(),
  technicals: { change7dPct: 8, change14dPct: 10, sma7: 0.008, sma30: 0.007, vsSma7: "above" } as MarketSnapshot["technicals"],
};
const mk = (thesis: string): TradeDecision => ({ side: "long", leverage: 1, thesis, reasoning: "" } as unknown as TradeDecision);

describe("objection-binding acceptance", () => {
// ── THE DISCRIMINATION TEST — the gate must tell responsive from non-responsive ──
it("responsive revision (drops the overstated claim) → satisfied", () => {
  const original = mk("strong breakout, up 21.8% parabolic move");   // overstates → magnitude flag
  const revised = mk("modest continuation, holding above support");   // no numeric overstatement
  const g = runObjectionGate(original, revised, market);
  assert.ok(g, "HOLD raised a magnitude objection → gate should run");
  const mag = g!.checked.find((c) => c.kind === "magnitude");
  assert.ok(mag, "magnitude objection should be tracked");
  assert.equal(mag!.satisfied, true, "revision dropped the overstated claim → should be satisfied");
});

it("NON-responsive revision (still overstates) → NOT satisfied", () => {
  const original = mk("up 21.8% parabolic move");   // magnitude flag
  const revised = mk("still up 21.8%, doubling down"); // STILL overstates the same way
  const g = runObjectionGate(original, revised, market);
  assert.ok(g, "gate should run");
  const mag = g!.checked.find((c) => c.kind === "magnitude");
  assert.ok(mag, "magnitude objection should be tracked");
  assert.equal(mag!.satisfied, false, "revision still contradicts measured fact → must NOT be satisfied");
});

// ── THE ANTI-NO-OP GUARD: the two above MUST differ. If they don't, the gate is
//    the trivial-true no-op and this fails loudly. ──
it("gate discriminates: responsive and non-responsive give DIFFERENT results", () => {
  const original = mk("up 21.8% breakout");
  const responsive = runObjectionGate(original, mk("modest, near fair value"), market);
  const nonResponsive = runObjectionGate(original, mk("up 21.8% still"), market);
  const rMag = responsive!.checked.find((c) => c.kind === "magnitude")!.satisfied;
  const nMag = nonResponsive!.checked.find((c) => c.kind === "magnitude")!.satisfied;
  assert.notEqual(rMag, nMag, "TRIVIAL-NO-OP: gate gave same verdict regardless of revision — it isn't checking the revision");
});

// ── Fact still measured from snapshot, not asserted: a revision claiming a false
//    LOW number must not pass just by asserting it. It passes only by not raising
//    the flag against the measured +8%. ──
it("agent cannot pass by asserting a convenient number — only by not contradicting the fact", () => {
  const original = mk("up 21.8%");
  // Revision claims "+8%" — which happens to match the fact, so it raises no flag → responsive.
  // This is correct: it stopped overstating. The point is it's checked AGAINST the
  // measured fact, not accepted because the agent typed a number.
  const g = runObjectionGate(original, mk("up 8% now, aligned with the tape"), market);
  const mag = g!.checked.find((c) => c.kind === "magnitude");
  assert.equal(mag!.satisfied, true);
});

it("no numeric objection in HOLD → gate returns null", () => {
  const g = runObjectionGate(mk("feels bullish, good energy"), mk("still bullish"), market);
  assert.equal(g, null);
});
});
