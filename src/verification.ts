// Verification module — routes a trade decision through ThoughtProof.
//
// Verified live 2026-06-09 against real backends:
//  - Sentinel: POST sentinel.thoughtproof.ai/sentinel/verify
//      headers: X-Sentinel-Key; body {claim, evidence, mode, tier}
//      mode "trade_execution"; tier "standard" = $0.005, ~1.3s (Nano→Pro cascade)
//      => {verdict, confidence, reasoning, objections[], attestation{...}, billing}
//  - RV: POST api.thoughtproof.ai/v1/check
//      headers: X-API-Key; body {claim, context, tier}
//      tier "standard" => {verdict, confidence, objections, durationMs, modelCount, mdi}
//      ~49s standard (2-model adversarial). ALLOW trust-but-verify only.
//
// Routing v3 (2026-06-15): Sentinel is the sole gate for UNCERTAIN and BLOCK.
// These return immediately with structured objections → agent Re-Plan Loop.
// RV only fires for weak/critical-stake ALLOWs (trust-but-verify).
// Conservative merge on RV path: BLOCK > UNCERTAIN > ALLOW.

import type { TradeDecision, VerificationResult, Verdict, MarketSnapshot } from "./types.js";
import { structuralCheck } from "./structural-check.js";

const SENTINEL_URL = "https://sentinel.thoughtproof.ai/sentinel/verify";
const RV_URL = "https://api.thoughtproof.ai/v1/check";

function normalizeVerdict(v: unknown): Verdict {
  const s = String(v ?? "").toUpperCase();
  if (s === "BLOCK" || s === "FAIL") return "BLOCK";
  if (s === "ALLOW" || s === "PASS") return "ALLOW";
  return "UNCERTAIN";
}

type SentinelObjection = { severity: "low" | "medium" | "high" | "critical"; explanation: string };

/**
 * Map Sentinel /sentinel/verify `objections[]` into the agent's objection shape
 * so a Sentinel-only gate can feed the agent the SAME quality of re-plan signal
 * RV provides. Sentinel emits { step_id, criterion, score, predicate, quote,
 * reasoning }; keep only failing/uncertain steps (passing steps aren't
 * objections) and translate predicate → severity. `reasoning` is already a
 * human-readable sentence (Sentinel synthesizes one when the model omits prose).
 */
function mapSentinelObjections(raw: unknown): SentinelObjection[] {
  if (!Array.isArray(raw)) return [];
  const sev: Record<string, SentinelObjection["severity"]> = {
    unsupported: "critical",
    unfaithful: "critical",
    partial: "medium",
    weakly_faithful: "medium",
    partially_faithful: "medium",
    skipped: "low",
  };
  return raw
    .filter((o) => {
      const p = String(o?.predicate ?? "");
      return p !== "supported" && p !== "faithful";
    })
    .map((o) => ({
      severity: sev[String(o?.predicate ?? "")] ?? "medium",
      explanation: String(o?.reasoning ?? o?.criterion ?? "").trim(),
    }))
    .filter((o) => o.explanation.length > 0);
}

async function callSentinel(
  decision: TradeDecision,
  apiKey: string,
  situation?: string, // action-free market snapshot (describeMarket) — see body
): Promise<NonNullable<VerificationResult["sentinel"]>> {
  // EVIDENCE must contain the raw market numbers, not just the agent's prose.
  // trade_execution mode's 3 critical gold steps ALL grade the claim against
  // `evidence`: (1) cited thresholds met by NUMBERS IN EVIDENCE, (2) directional
  // claims match PRICE DATA IN EVIDENCE, (3) every justification references DATA
  // PRESENT IN EVIDENCE. Before this fix, evidence held only Thesis+Reasoning,
  // so a clean trade whose thesis didn't verbatim restate every snapshot number
  // failed gold steps 1 & 3 as "unsupported" — a false-positive BLOCK (root cause
  // of the ~3% ALLOW rate). We prepend the action-free market snapshot (the same
  // `situation` RV already receives, describeMarket → price, SMA7/30, RSI, vol,
  // trend) so the grounding check runs against the actual data the agent saw.
  // `situation` is action-free (no buy/sell/long/short), so it cannot leak the
  // decision into the evidence and pre-bias the verdict.
  const marketBlock = situation && situation.trim() ? `Market data (verifier evidence):\n${situation.trim()}\n\n` : "";
  const res = await fetch(SENTINEL_URL, {
    method: "POST",
    headers: { "X-Sentinel-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      // claim = the ANSWER Sentinel grades. trade_reasoning's step_2 checks
      // inferential integrity (does the thesis follow from its reasoning?), so
      // the thesis MUST be in the claim, not only the bare action string.
      claim: `${decision.action}. Thesis: ${decision.thesis}`,
      evidence: `${marketBlock}Thesis: ${decision.thesis}\n\nReasoning: ${decision.reasoning}`,
      // trade_reasoning (ADR-0018), NOT trade_execution. Rationale: a trading
      // thesis is an argument, not a trace — the "evidence" is the agent's own
      // reasoning, so demanding literal evidence-grounding always yields "weakly
      // supported" → CONDITIONAL_ALLOW → UNCERTAIN → the trade dies (drove ~82%
      // of UNCERTAINs in the CB4A benchmark; and 97% of VTA directional attempts
      // never executed). trade_reasoning keeps the two FACTUAL gold steps
      // (thresholds + direction, backstopped by the deterministic cb4a-verify
      // structural layer) but replaces step_2 with an inferential-integrity check
      // and promotes UNCERTAIN→ALLOW when only step_2 is marginal. Live A/B
      // (2026-07-06): clean XLM 2x long UNCERTAIN→ALLOW; bad ETH 2x
      // UNCERTAIN→BLOCK (genuine defects caught HARDER, not softer).
      mode: "trade_reasoning",
      tier: "standard",
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
    objections: mapSentinelObjections(d.objections),
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
 * Verify a trade decision. Sentinel Standard (Nano→Pro cascade) is the SOLE
 * gate for UNCERTAIN and BLOCK verdicts — they return immediately with
 * structured objections for the agent's Re-Plan Loop.
 *
 * RV escalation ($0.05-0.10, ~70s) is reserved ONLY for ALLOW trust-but-verify:
 *   - Critical stake + Sentinel ALLOW → mandatory RV (too much capital for one gate)
 *   - Weak-conviction ALLOW (<0.6, or <0.8 for high stake) → RV arbitrates
 *
 * This means UNCERTAIN never burns an RV call. The agent gets Sentinel's
 * feedback (~1-3s, $0.005) and either revises or stands down.
 *
 * `situation` (optional): action-free description of the decision situation
 * (market snapshot). Passed to RV so its generator panel can form independent
 * positions before seeing our decision. Use describeMarket(market).
 */
export async function verifyDecision(
    decision: TradeDecision,
    apiKey: string,
    situation?: string,
    market?: MarketSnapshot,
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

    // --- Layer 1: deterministic structural check (cb4a-verify pattern) ---
    // Runs BEFORE the LLM cascade. Two outputs:
    //   (a) a HARD direction contradiction → BLOCK immediately, never spend the
    //       Sentinel cascade. This is the binary, unfixable defect the LLM layer
    //       is unreliable on (an agent claiming "uptrend" while the 7d trend is
    //       decisively down). Fail-toward-silence: only fires on a high-confidence
    //       parse beyond a generous tolerance, so it cannot false-block a good trade.
    //   (b) soft `structural_fact:` flags → prepended to the situation so Sentinel
    //       (trade_reasoning mode) treats them as authoritative ground truth when
    //       judging coherence. This is what makes the two-layer gate REAL for the
    //       trade path, not just a claim.
    let sentinelSituation = situation;
    if (market) {
      const structural = structuralCheck(decision, market);
      // Direction/magnitude/range deviations are surfaced as `structural_fact:`
      // evidence lines (authoritative ground truth) and prepended to the
      // situation Sentinel grades. No deterministic hard-BLOCK: whether a
      // counter-trend read or a magnitude gap invalidates the thesis is a
      // JUDGMENT the reasoning layer (Sentinel trade_reasoning), which sees the
      // full thesis, is the right place to make. Layer 1 proves the facts; Layer
      // 2 decides. (Steelman 2026-07-06: a det direction hard-block false-blocks
      // legitimate oversold-bounce / mean-reversion trades.)
      if (structural.flags.length > 0) {
        const factBlock = structural.flags.map((f: { evidenceLine: string }) => f.evidenceLine).join("\n");
        sentinelSituation = situation ? `${factBlock}\n\n${situation}` : factBlock;
      }
    } else {
      // Fail-open is a hidden gap: Layer 1 is silently skipped when no snapshot
      // is passed. main.ts always passes `market`, so this should never fire in
      // production — log loudly if it does (Steelman 2026-07-06, finding 3).
      console.warn(
        `⚠️  structural check SKIPPED for ${decision.symbol} — no market snapshot passed to verifyDecision (Layer 1 bypassed).`,
      );
    }

    const sentinel = await callSentinel(decision, apiKey, sentinelSituation);

  // --- Routing v3: UNCERTAIN/BLOCK stay Sentinel-final ---
  // UNCERTAIN → return with objections for Re-Plan Loop.
  // BLOCK → return with objections (hard or soft — agent sees the critique).
  // In both cases, escalating to RV would just burn cost — the objections are
  // already actionable. The Re-Plan Loop in main.ts feeds them back to the
  // agent, who either revises or stands down.
  if (sentinel.verdict === "UNCERTAIN" || sentinel.verdict === "BLOCK") {
    return {
      route: "sentinel",
      finalVerdict: sentinel.verdict,
      sentinel,
      latencyMs: Date.now() - start,
    };
  }

  // --- ALLOW: trust-but-verify for high-stakes ---
  // RV escalation can be disabled entirely (RV_ENABLED=false) — e.g. for a
  // Sentinel-only demo that showcases the pre-execution gate + Re-Plan Loop
  // without the slower (~50s) RV adversarial panel. When off, a Sentinel ALLOW
  // is always final.
  const rvEnabled = (process.env.RV_ENABLED ?? "true").toLowerCase() !== "false";
  const stakeLevel = decision.stakeLevel ?? "high";
  const escalateToRv = rvEnabled && (() => {
    // Critical stake: mandatory RV verification on any ALLOW
    if (stakeLevel === "critical") return true;
    // High stake: escalate if Sentinel's confidence is below threshold
    if (stakeLevel === "high" && sentinel.confidence < 0.8) return true;
    // Medium/low: escalate only on very weak conviction
    if (sentinel.confidence < 0.6) return true;
    return false;
  })();

  if (!escalateToRv) {
    // Sentinel ALLOW with strong confidence — final.
    return {
      route: "sentinel",
      finalVerdict: "ALLOW",
      sentinel,
      latencyMs: Date.now() - start,
    };
  }

  // RV arbitrates the weak ALLOW.
  const rv = await callRV(decision, apiKey, situation);

  // RV verdict leads (Sentinel already ALLOW'd, so only RV can change the outcome).
  const finalVerdict: Verdict =
    rv.verdict === "BLOCK"
      ? "BLOCK"
      : rv.verdict === "UNCERTAIN"
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
