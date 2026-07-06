// Deterministic structural fact-check for trading theses — VTA-local port of
// cb4a-verify/src/fact-check.ts (the sister neuro-symbolic pattern). This is
// Layer 1 of the two-layer gate for the TRADE path:
//
//   Layer 1 (this module, deterministic): parse HIGH-CONFIDENCE claims out of
//     the agent's thesis and check them against verified market data.
//       - direction contradiction  → HARD BLOCK before Sentinel is even called
//       - magnitude / range-pos deviation → soft "structural_fact:" evidence
//         lines forwarded to Sentinel as authoritative ground truth
//   Layer 2 (Sentinel trade_reasoning): coherence of the reasoning GIVEN those
//     verified facts.
//
// PHILOSOPHY — fail toward silence. Only speak when we (a) extracted a claim
// with HIGH confidence AND (b) it violates ground truth beyond a GENEROUS
// tolerance. On ANY parse ambiguity → stay silent and let the trade proceed to
// Sentinel. Blocking a good trade over a rounding artifact is the failure mode
// that killed the earlier "send raw market data to Sentinel" experiment; this
// checker exists precisely to NOT do that. NEVER throws.
//
// Scope — only robustly-extractable, high-value checks. Everything qualitative
// ("strong momentum", "climactic volume") is interpretive and goes to Sentinel.

import type { TradeDecision, MarketSnapshot } from "./types.js";

export interface VerifiedFactFlag {
  kind: "direction" | "magnitude" | "range_position";
  evidenceLine: string; // "structural_fact: ..." — trusted ground truth for Sentinel
}

export interface StructuralCheckResult {
  // No hard-block path: direction mismatch is now a soft flag (Sentinel judges
  // whether a counter-trend read is defensible). Kept as a flags-only result so
  // the deterministic layer proves facts and the reasoning layer makes the call.
  flags: VerifiedFactFlag[]; // → prepend to Sentinel evidence
}

// ── Tolerances (deliberately generous; see PHILOSOPHY) ──
const DIRECTION_CONTRADICTION_MIN_PCT = 3.0; // flat/noisy market → no flag
const MAGNITUDE_FLAG_MIN_PP = 10.0; // 21.8 vs 21.3 silent; 21.8 vs 8 flagged
const RANGE_FLAG_MIN_PP = 15.0; // range is interpretation-dependent

const BULLISH = /\b(uptrend|up\s?trend|bullish|breakout|breaking out|momentum (?:continuation|leader)|rally|surging|surge|pressing (?:the )?(?:upper|highs?|top)|higher highs?)\b/i;
const BEARISH = /\b(downtrend|down\s?trend|bearish|breakdown|breaking down|selloff|sell-?off|collapsing|falling|lower lows?|pressing (?:the )?(?:lower|lows?|bottom))\b/i;

/** Asserted direction from thesis+reasoning. null when ambiguous (both/neither) → silence. */
function extractDirection(text: string): "up" | "down" | null {
  const bull = BULLISH.test(text);
  const bear = BEARISH.test(text);
  if (bull === bear) return null;
  return bull ? "up" : "down";
}

/** A single dominant %-move claim. null unless exactly one high-confidence % present. */
function extractMovePct(text: string): { value: number; claimText: string } | null {
  const patterns = [
    /\b(?:up|gained?|rose|rallied|surged)\s+(\d{1,3}(?:\.\d+)?)\s?%/i,
    /\b(?:down|lost|fell|dropped|declined?)\s+(\d{1,3}(?:\.\d+)?)\s?%/i,
    /([+-]\s?\d{1,3}(?:\.\d+)?)\s?%/,
    /\b(\d{1,3}(?:\.\d+)?)\s?%\s+(?:up|gain|higher|move)\b/i,
  ];
  const found: { value: number; claimText: string }[] = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/\s/g, ""));
      if (Number.isFinite(v)) found.push({ value: Math.abs(v), claimText: m[0].trim() });
    }
  }
  const distinct = [...new Set(found.map((f) => f.value))];
  if (distinct.length !== 1) return null;
  return found[0];
}

/** A "NN% of range" position claim. null if none/ambiguous. */
function extractRangePos(text: string): { value: number; claimText: string } | null {
  const re = /(\d{1,3}(?:\.\d+)?)\s?%\s+of\s+(?:its\s+|the\s+|recent\s+|the recent\s+)?(?:\d+-?candle\s+)?range/i;
  const matches = [...text.matchAll(new RegExp(re, "gi"))];
  if (matches.length !== 1) return null;
  const v = parseFloat(matches[0][1]);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return { value: v, claimText: matches[0][0].trim() };
}

/**
 * Run the deterministic structural check. Pure function; NEVER throws — on any
 * internal issue returns an empty result (silence), preserving fail-toward-silence.
 *
 * Verified ground truth is drawn from the SAME snapshot the agent reasoned over:
 *   - 24h change  ← market.priceChangePct24h
 *   - window trend← technicals.change7dPct (the multi-day trend the thesis reads)
 *   - range pos   ← computed from price within [low24h, high24h]
 */
export function structuralCheck(decision: TradeDecision, market: MarketSnapshot): StructuralCheckResult {
  const flags: VerifiedFactFlag[] = [];
  try {
    const text = `${decision.thesis}\n${decision.reasoning}`;
    const t = market.technicals ?? null;
    const trendPct = t ? t.change7dPct : null; // multi-day window trend
    const rangePos =
      market.high24h > market.low24h
        ? ((market.price - market.low24h) / (market.high24h - market.low24h)) * 100
        : null;

    // ── 1. Direction coherence → SOFT flag (NOT hard block) ──
    // Steelman 2026-07-06: a HARD block here false-blocks legitimate
    // counter-trend trades — an oversold-bounce long on a 7d-down asset, or a
    // mean-reversion short on a 7d-up asset, are core professional strategies,
    // not fabrications. The thesis's directional WORD ("uptrend"/"bullish")
    // mismatching the 7d trend is NOT proof of a lie: the agent may be reading a
    // sub-window, order-flow, or an explicit contrarian setup.
    //
    // So we DON'T hard-block on direction. We surface the verified trend as a
    // `structural_fact:` line and let Sentinel's coherence layer (which sees the
    // FULL thesis + reasoning) judge whether the counter-trend read is
    // defensible ("oversold bounce with bullish divergence" = coherent) or a
    // genuine contradiction ("strong uptrend, momentum continuation" while the
    // market fell 12% = incoherent → Sentinel BLOCKs it). This keeps the
    // deterministic layer to what it can prove (the trend number) and leaves the
    // JUDGMENT (is the divergence justified?) to the reasoning verifier — the
    // correct neuro-symbolic split. Fail-toward-silence preserved: no direction
    // word, or a trend within tolerance, stays silent.
    const claimedDir = extractDirection(text);
    if (trendPct !== null && claimedDir) {
      const decisive = Math.abs(trendPct) >= DIRECTION_CONTRADICTION_MIN_PCT;
      const actualDir = trendPct > 0 ? "up" : "down";
      if (decisive && claimedDir !== actualDir) {
        flags.push({
          kind: "direction",
          evidenceLine:
            `structural_fact: verified 7d trend = ${trendPct >= 0 ? "+" : ""}${trendPct.toFixed(1)}% (${actualDir}); ` +
            `thesis reads ${claimedDir === "up" ? "bullish/uptrend" : "bearish/downtrend"}. ` +
            `If the thesis is an explicit counter-trend/mean-reversion setup this may be intentional — ` +
            `assess whether the reasoning justifies trading against the verified trend; if the thesis simply ` +
            `asserts the trend direction as its edge, this is a contradiction.`,
        });
      }
    }

    // ── 2. Magnitude (±NN% claim) → soft flag ──
    const move = extractMovePct(text);
    if (move) {
      const candidates = [Math.abs(market.priceChangePct24h)];
      if (trendPct !== null) candidates.push(Math.abs(trendPct));
      const nearest = candidates.reduce((best, v) =>
        Math.abs(v - move.value) < Math.abs(best - move.value) ? v : best,
      );
      if (Math.abs(nearest - move.value) > MAGNITUDE_FLAG_MIN_PP) {
        flags.push({
          kind: "magnitude",
          evidenceLine:
            `structural_fact: verified move ≈ ${market.priceChangePct24h >= 0 ? "+" : ""}${market.priceChangePct24h.toFixed(1)}% 24h` +
            (trendPct !== null ? `, ${trendPct >= 0 ? "+" : ""}${trendPct.toFixed(1)}% 7d` : "") +
            `; thesis claims "${move.claimText}". Assess whether the thesis still holds given the verified figure.`,
        });
      }
    }

    // ── 3. Range position (X% of range) → soft flag ──
    const rng = extractRangePos(text);
    if (rng && rangePos !== null) {
      if (Math.abs(rangePos - rng.value) > RANGE_FLAG_MIN_PP) {
        flags.push({
          kind: "range_position",
          evidenceLine:
            `structural_fact: verified range position = ${rangePos.toFixed(0)}% of ` +
            `[${market.low24h}–${market.high24h}] (24h); thesis claims "${rng.claimText}". ` +
            `Assess whether the thesis still holds.`,
        });
      }
    }
  } catch {
    return { flags: [] }; // never block on a checker bug
  }
  return { flags };
}
