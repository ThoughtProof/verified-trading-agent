// Verification module — routes a trade decision through ThoughtProof.
//
// Verified live 2026-06-09 against real backends:
//  - Sentinel: POST sentinel.thoughtproof.ai/sentinel/verify
//      headers: X-Sentinel-Key; body {claim, evidence, mode, tier}
//      mode "trade_execution" exists; tier "checkpoint" = $0.003, ~3.5s
//      => {verdict, confidence, reasoning, attestation{claim_hash,...}, billing}
//  - RV: POST api.thoughtproof.ai/v1/check
//      headers: X-API-Key; body {claim, context, tier}
//      tier "standard" => {verdict, confidence, objections, durationMs, modelCount, mdi}
//      ~49s standard (2-model adversarial). High-stakes only.
//
// Routing: Sentinel first (cheap pre-execution gate). If Sentinel doesn't BLOCK
// and the decision is high-stakes, escalate to RV. Conservative merge:
// BLOCK > UNCERTAIN > ALLOW.

import type { TradeDecision, VerificationResult, Verdict } from "./types.js";

const SENTINEL_URL = "https://sentinel.thoughtproof.ai/sentinel/verify";
const RV_URL = "https://api.thoughtproof.ai/v1/check";

function normalizeVerdict(v: unknown): Verdict {
  const s = String(v ?? "").toUpperCase();
  if (s === "BLOCK" || s === "FAIL") return "BLOCK";
  if (s === "ALLOW" || s === "PASS") return "ALLOW";
  return "UNCERTAIN";
}

async function callSentinel(
  decision: TradeDecision,
  apiKey: string,
): Promise<NonNullable<VerificationResult["sentinel"]> & { attestation?: any }> {
  const res = await fetch(SENTINEL_URL, {
    method: "POST",
    headers: { "X-Sentinel-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      claim: decision.action,
      evidence: `Thesis: ${decision.thesis}\n\nReasoning: ${decision.reasoning}`,
      mode: "trade_execution",
      tier: "checkpoint",
    }),
  });
  if (!res.ok) {
    throw new Error(`Sentinel failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, any>;
  return {
    verdict: normalizeVerdict(d.verdict),
    confidence: Number(d.confidence ?? 0),
    reason: String(d.reasoning ?? ""),
    attestation: d.attestation,
  };
}

async function callRV(
  decision: TradeDecision,
  apiKey: string,
): Promise<NonNullable<VerificationResult["rv"]>> {
  const res = await fetch(RV_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      claim: `${decision.action}. Thesis: ${decision.thesis}`,
      context: `Autonomous crypto trading agent, $50k perpetual account. Full reasoning chain: ${decision.reasoning}`,
      tier: "standard",
    }),
  });
  if (!res.ok) {
    throw new Error(`RV failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, any>;
  const objections = Array.isArray(d.objections)
    ? d.objections.map((o: any) => ({
        severity: (o.severity ?? "medium") as "low" | "medium" | "high" | "critical",
        explanation: String(o.explanation ?? o.text ?? o.claim ?? ""),
      }))
    : [];
  return {
    verdict: normalizeVerdict(d.verdict),
    confidence: Number(d.confidence ?? 0),
    summary: String(d.summary ?? d.reasoning ?? ""),
    objections,
    attestation: d.attestation
      ? {
          type: String(d.attestation.type ?? "tp"),
          hash: d.attestation.hash,
          signature: d.attestation.signature,
          receiptId: d.attestation.receiptId ?? d.id,
        }
      : undefined,
  };
}

/**
 * Verify a trade decision. Sentinel gate first; escalate to RV for high-stakes
 * decisions that survive Sentinel. Returns the merged result.
 */
export async function verifyDecision(
  decision: TradeDecision,
  apiKey: string,
): Promise<VerificationResult> {
  const start = Date.now();

  // Flat / no-op: nothing irreversible to gate. Treat as ALLOW (no trade anyway).
  if (decision.side === "flat") {
    return {
      route: "sentinel",
      finalVerdict: "ALLOW",
      latencyMs: Date.now() - start,
    };
  }

  const sentinel = await callSentinel(decision, apiKey);

  // Sentinel blocks → stop. No need to pay for RV.
  if (sentinel.verdict === "BLOCK") {
    return {
      route: "sentinel",
      finalVerdict: "BLOCK",
      sentinel: { verdict: sentinel.verdict, confidence: sentinel.confidence, reason: sentinel.reason },
      latencyMs: Date.now() - start,
    };
  }

  // Routine (low-stakes) decision that passed Sentinel → done.
  if (!decision.highStakes) {
    return {
      route: "sentinel",
      finalVerdict: sentinel.verdict,
      sentinel: { verdict: sentinel.verdict, confidence: sentinel.confidence, reason: sentinel.reason },
      latencyMs: Date.now() - start,
    };
  }

  // High-stakes → escalate to RV adversarial verification.
  // (Sentinel already passed the BLOCK gate above, so only RV can still BLOCK here.)
  const rv = await callRV(decision, apiKey);

  // Conservative merge: BLOCK > UNCERTAIN > ALLOW
  const finalVerdict: Verdict =
    rv.verdict === "BLOCK"
      ? "BLOCK"
      : sentinel.verdict === "UNCERTAIN" || rv.verdict === "UNCERTAIN"
        ? "UNCERTAIN"
        : "ALLOW";

  return {
    route: "pipeline",
    finalVerdict,
    sentinel: { verdict: sentinel.verdict, confidence: sentinel.confidence, reason: sentinel.reason },
    rv,
    latencyMs: Date.now() - start,
  };
}
