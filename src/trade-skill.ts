// ThoughtProof Trading Skill — the installable pre-trade reasoning guard.
//
// WHAT THIS IS
// ------------
// The trading counterpart to the wallet pre-sign guard: a skill an autonomous
// trading agent installs and runs BEFORE it opens a position via the `mm perps`
// CLI. It wraps the two-layer verification pipeline and turns a proposed trade
// into an `mm perps open` command — but ONLY on an explicit ALLOW.
//
//   decision = agent.reason(market)              // long / short / flat + thesis
//   verdict  = thoughtproof.verify(decision)     // structural + reasoning  ← this skill
//   if verdict == ALLOW:  mm perps open ...       // the venue executes
//   else:                 mm is NEVER invoked. The order never leaves the agent.
//
// WHY A SEPARATE SKILL FROM THE WALLET GUARD (the point)
// ------------------------------------------------------
// Wallet-scope checks (unlimited approval, injected recipient, amount overshoot)
// are DETERMINISTIC — a wallet/CLI can and should build those itself. Trade
// REASONING cannot be built deterministically: whether a thesis is defensible
// (hallucinated indicator, invented level, contradicted data, momentum chase
// dressed up as analysis) is not a rule check. That is the axis this skill
// covers and the reason it is ThoughtProof's, not something the venue rebuilds.
//
//   Layer 1 (deterministic, local): structural fact-check — direction vs the
//            verified window trend, magnitude, range position. Surfaces
//            `structural_fact:` ground truth; never hard-blocks on its own.
//   Layer 2 (Sentinel, trade_reasoning mode): adversarial reasoning verdict
//            against that ground truth. RV escalation is trust-but-verify on
//            high-stakes ALLOWs only.
//
// EXECUTION MODES (env MM_EXECUTION_MODE — identical contract to the wallet skill)
//   off    — default. Guard still evaluates + returns the verdict, never touches mm.
//   dryrun — on ALLOW, build the exact `mm perps open` command; read-only probe
//            (`mm auth status`) proves the binary is reachable. No order sent.
//   live   — on ALLOW, actually open the position. Requires `mm login` + funded
//            wallet. Operator opt-in, never default.
//
// HONESTY: fail-closed. BLOCK and UNCERTAIN both stop the order — UNCERTAIN is
// not a soft pass, it returns the objections to the agent for a re-plan. On a
// venue/session hiccup we fail closed and never claim a fill that didn't happen.

import { verifyDecision } from "./verification.js";
import { executeViaMetaMask, getExecutionMode, type ExecutionResult } from "./metamask-executor.js";
import { describeMarket } from "./signal.js";
import type { TradeDecision, MarketSnapshot, VerificationResult } from "./types.js";

export interface RunTradeSkillOptions {
  /** ThoughtProof Sentinel API key (X-Sentinel-Key). */
  apiKey: string;
}

export interface TradeSkillResult {
  verification: VerificationResult;
  execution: ExecutionResult;
  /** Convenience: did the order actually reach the venue? */
  executed: boolean;
}

/**
 * The installable pre-trade guard. One call: verify the reasoning behind a
 * proposed trade, then (only on ALLOW) route it to `mm perps` per the current
 * MM_EXECUTION_MODE. The verdict is ALWAYS real — a live Sentinel call, never
 * hand-set.
 */
export async function runTradeSkill(
  decision: TradeDecision,
  market: MarketSnapshot,
  opts: RunTradeSkillOptions,
): Promise<TradeSkillResult> {
  // Action-free market snapshot = the situation the reasoning is graded against
  // (so the verdict grades the thesis, not a restatement of the decision).
  const situation = describeMarket(market);

  const verification = await verifyDecision(decision, opts.apiKey, situation, market);

  // The gate: executeViaMetaMask itself enforces "only ALLOW touches mm" and
  // handles the off/dryrun/live contract + fail-closed retries.
  const execution = await executeViaMetaMask(verification.finalVerdict, decision, market);

  return {
    verification,
    execution,
    executed: execution.status === "executed",
  };
}

/** Re-export so a consumer can check the mode without importing the executor. */
export { getExecutionMode };
