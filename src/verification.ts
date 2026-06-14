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
): Promise<NonNullable<VerificationResult["sentinel"]>> {
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
  const att = d.attestation as Record<string, any> | undefined;
  return {
    verdict: normalizeVerdict(d.verdict),
    confidence: Number(d.confidence ?? 0),
    reason: String(d.reasoning ?? ""),
    // M2 fix: carry the cryptographic proof through to the record — this is the
    // evidence anchor that makes "signed, non-refutable verdict" real, not a claim.
    attestation: att
      ? {
          prepared: Boolean(att.prepared),
          issued: Boolean(att.issued),
          schemaUid: att.schema_uid,
          claimHash: att.claim_hash,
          evidenceHash: att.evidence_hash,
        }
      : undefined,
  };
}

async function callRV(
  decision: TradeDecision,
  apiKey: string,
  situation?: string, // action-free market snapshot (describeMarket) — see body
): Promise<NonNullable<VerificationResult["rv"]>> {
  const res = await fetch(RV_URL, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      claim: `${decision.action}. Thesis: ${decision.thesis}`,
      context: `Autonomous crypto trading agent, $50k perpetual account. Full reasoning chain: ${decision.reasoning}`,
      // SEND action-free `situation` (the raw market snapshot from describeMarket).
      // 2026-06-14 60-call A/B (4 cases x 3 framings x 5 runs, manually audited):
      //   - NO situation: 15% of runs FULLY HALLUCINATED a phantom decision
      //     (invented "capital investment project", NPV, "$50M loss", discount
      //     rates) and critiqued that instead of the trade. This is the demo-killer
      //     and the exact failure mode we sell RV to catch.
      //   - CLEAN situation (this): 0% fabrication; objections were coherent and
      //     often sharp (caught an arithmetically wrong R/R, funding-rate omission,
      //     undefined stop distance). ~20% had one weak "I wasn't given the
      //     decision" objection out of three — tolerable, not fabrication.
      // The earlier "do NOT send situation" note was based on too few runs and is
      // WRONG. `situation` MUST be action-free (market data only, no buy/sell/long/
      // short) — describeMarket already guarantees this. Do not re-add the action.
      ...(situation && situation.trim() ? { situation: situation.trim() } : {}),
      speed: "standard",
      // stakeLevel drives RV's verdict threshold (micro 0.40 → critical 0.85).
      // Mirrors cb4a-verify: higher stake demands sounder reasoning to ALLOW.
      // Without this, RV used its default threshold regardless of position risk.
      stakeLevel: decision.stakeLevel,
      // Request the ECDSA-signed onchain proof (free — signing only, no extra
      // model cost). Without this the RV verdict carries NO signature and the
      // block-log's "signed verdict" claim rests on Sentinel hashes alone.
      onchain: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`RV failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, any>;
  // /v1/check returns objections as an array of plain strings (top material/notable
  // descriptions). Older code mapped o.explanation/o.text/o.claim assuming objects —
  // that silently produced empty explanations. Handle both shapes defensively.
  const objections = Array.isArray(d.objections)
    ? d.objections
        .map((o: any) => {
          if (typeof o === "string") {
            return { severity: "medium" as const, explanation: o };
          }
          return {
            severity: (o.severity ?? o.materiality ?? "medium") as
              | "low"
              | "medium"
              | "high"
              | "critical",
            explanation: String(o.explanation ?? o.description ?? o.text ?? o.claim ?? ""),
          };
        })
        .filter((o: { explanation: string }) => o.explanation.length > 0)
    : [];
  // The signed proof comes back as `onchain_proof` (when onchain:true was sent):
  // { hash, signature, signer, verdict, confidence_bps }. Older deploys exposed
  // `attestation` — keep that as a fallback shape.
  const proof = (d.onchain_proof ?? d.attestation) as Record<string, any> | undefined;
  return {
    verdict: normalizeVerdict(d.verdict),
    confidence: Number(d.confidence ?? 0),
    summary: String(d.summary ?? d.reasoning ?? ""),
    objections,
    modelCount: typeof d.modelCount === "number" ? d.modelCount : undefined,
    profile: d.verificationProfile ? String(d.verificationProfile) : undefined,
    attestation: proof
      ? {
          type: String(proof.type ?? (d.onchain_proof ? "onchain_proof" : "tp")),
          hash: proof.hash,
          signature: proof.signature,
          signer: proof.signer,
          receiptId: proof.receiptId ?? d.id,
        }
      : undefined,
  };
}

/**
 * Verify a trade decision. Sentinel gate first; escalate to RV for high-stakes
 * decisions that survive Sentinel. Returns the merged result.
 *
 * `situation` (optional): action-free description of the decision situation
 * (market snapshot). Passed to RV so its generator panel can form independent
 * positions before seeing our decision. Use describeMarket(market).
 */
export async function verifyDecision(
  decision: TradeDecision,
  apiKey: string,
  situation?: string,
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
      sentinel,
      latencyMs: Date.now() - start,
    };
  }

  // Routine (low-stakes) decision that passed Sentinel → done.
  // "micro" stake (flat / no-op) never reaches here as directional, but guard
  // anyway: micro = Sentinel-only fast gate, no RV escalation.
  // Note: sentinel.verdict here is ALLOW or UNCERTAIN. UNCERTAIN is fail-closed
  // downstream (main.ts treats anything != ALLOW as "not executed").
  if (decision.stakeLevel === "micro") {
    return {
      route: "sentinel",
      finalVerdict: sentinel.verdict,
      sentinel,
      latencyMs: Date.now() - start,
    };
  }

  // Everything else (medium/high/critical) → escalate to RV adversarial
  // verification. RV applies the stake-calibrated threshold (medium 0.65 →
  // critical 0.85), so a large 1x directional bet is now verified too — not
  // just 3x+ leverage. This is the fix for the SKALE agent resting on
  // Sentinel's UNCERTAIN default.
  // (Sentinel already passed the BLOCK gate above, so only RV can still BLOCK here.)
  const rv = await callRV(decision, apiKey, situation);

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
    sentinel,
    rv,
    latencyMs: Date.now() - start,
  };
}
