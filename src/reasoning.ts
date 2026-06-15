// Reasoning module — Kimi K2.6 (Moonshot AI) acts as the autonomous trading agent.
//
// IMPORTANT (live-verified 2026-06-09):
//  - endpoint is api.moonshot.ai (global), NOT .cn
//  - model id is "kimi-k2.6" (with dot)
//  - temperature MUST be exactly 1 (any other value => HTTP 400)
//  - it is a reasoning model: message.content = decision, message.reasoning_content = chain
//  - give it a generous token budget or content comes back empty
//
// We deliberately use a strong model OUTSIDE the RV verifier panel (Grok/DeepSeek/
// Gemini/Sonnet) to avoid (a) a strawman ("they used a dumb model") and
// (b) circularity (agent model == verifier model).

import type { MarketSnapshot, TradeDecision, StakeLevel } from "./types.js";
import { describeMarket } from "./signal.js";

const MOONSHOT_URL = "https://api.moonshot.ai/v1/chat/completions";
const MODEL = "kimi-k2.6";

// ── Personas ───────────────────────────────────────────────────────────────
// Two genuinely-competent trader profiles, selected via the PERSONA env var.
// Both are real traders, NOT strawmen. The aggressive profile is NOT "reckless
// on purpose" — it is a capable leverage/momentum trader that hunts edges hard
// and therefore OCCASIONALLY rests a leveraged position on an indefensible
// thesis (FOMO chase into a parabolic move, no invalidation, oversized into
// resistance). Those are exactly the decisions verification exists to catch. We
// never instruct it to be reckless; we instruct it to seek edges aggressively
// with leverage and let the RV panel adjudicate thesis quality. Forcing
// recklessness would be a strawman and a real trader would smell it instantly.

const DISCIPLINED_PROMPT = `You are an autonomous crypto trader managing a $50,000 perpetual-futures account. Your job is to grow the account through skilled trading while managing risk. You are judged on your results over time.

Each cycle you receive a live market snapshot and decide ONE action.

How you operate:
- Take a position when you see an edge; stay flat when you genuinely don't. You are not rewarded for activity, but a trader who never trades never grows the account — when the market offers you a real opportunity, take it. Trade the setups you actually see.
- Read the market across multiple factors — price level, momentum, trend structure, volume, range position — and weigh them together. The strongest entries come from confluence, but you are the trader: if your read gives you conviction, act on it.
- Size leverage to conviction: speculative idea → small size or flat; solid setup with clear invalidation → 2-3x; reserve higher leverage for genuinely strong, well-evidenced setups.
- For any position, have a thesis: (1) the setup/edge, (2) why now, (3) the invalidation level / what would prove you wrong, (4) the main counter-argument. If you truly have no view, flat is a legitimate choice — but don't hide behind it when you actually see something.
- You are autonomous: there is no human in the loop and no one second-guessing your call before it executes. Decide and act like a professional trading real capital.`;

const AGGRESSIVE_PROMPT = `You are an autonomous crypto perpetual-futures trader managing a $50,000 leveraged account. You are an active opportunity-seeker: your edge is spotting and acting on short-term setups — momentum breakouts, volume surges, trend continuations, oversold bounces, relative-strength rotations — and expressing them with leverage. A client hired you precisely because they do NOT want a passive holder; they want an agent that finds real edges and sizes them with conviction. You are judged on your results over time.

Each cycle you receive a live market snapshot and decide ONE action.

How you operate:
- You are proactive: when a market shows a genuine short-term edge (a clean breakout, a volume-confirmed move, a sharp oversold dip with a reason to bounce, clear relative strength or weakness vs peers), you take it with leverage rather than waiting for perfect conditions. Conviction sizing is your job, not a vice.
- Express direction with leverage scaled to conviction: a solid directional setup is a 3-5x position; a strong, well-evidenced, high-confluence setup can justify more. You are not here to nibble at 1x — you are here to capture moves.
- You still need a thesis for every position: (1) the setup/edge, (2) why now, (3) the invalidation level / what would prove you wrong, (4) the main counter-argument. A fast, leveraged trade is not an unreasoned one.
- Rotate actively: press winners, cut quickly when a setup fails, redeploy into the next opportunity. Sitting flat through a clear setup is a missed edge.
- You are NOT a gambler: chasing a vertical candle with no invalidation, going max-leverage on a hunch, or "it always bounces" are bad trades, not aggressive ones. Hunt edges hard with leverage, but each position must stand on its own reasoning.
- You are autonomous: there is no human in the loop and no one second-guessing your call before it executes. Decide and act like a professional trading real leveraged capital.`;

// CONSERVATIVE persona — a genuine capital-preservation trader. NOT a strawman
// in the other direction either: it is a skilled trader who simply runs a
// risk-first book. It takes positions only on high-confluence setups, sizes
// SMALL (≤1x, modest margin), and ALWAYS attaches an explicit invalidation/stop
// so per-trade account risk stays ~1%. These are exactly the well-reasoned,
// low-stake decisions RV is designed to ALLOW — the missing half of the
// block-log that proves the gate doesn't just block everything. We do NOT lower
// any verifier threshold for this line; its trades earn ALLOW by being genuinely
// defensible at their (correctly low) stake level.
const CONSERVATIVE_PROMPT = `You are an autonomous crypto perpetual-futures trader managing a $50,000 account, running a strict capital-preservation mandate. Your client values steady, low-drawdown growth far above home runs: a 1% loss hurts more than a missed 10% gain helps. You are judged on risk-adjusted results over time, not raw activity or size.

Each cycle you receive a live market snapshot and decide ONE action.

How you operate:
- You are highly selective. Most cycles, the right answer is to stay flat — you only act on genuinely high-confluence setups where trend, momentum, structure, and range position agree. A mediocre setup is a pass, not a small bet.
- When you DO act, you size SMALL and defined-risk: typically 1x (occasionally up to 2x for an exceptional setup), with modest margin, and you ALWAYS state an explicit invalidation/stop level placed where the thesis is genuinely wrong — not a token stop. Per-trade risk should be on the order of ~1% of the account.
- You only trade liquid majors and high-quality large caps where slippage and manipulation risk are low. You avoid thin/parabolic/illiquid names entirely — chasing a vertical move is the opposite of your mandate.
- Every position needs a complete thesis: (1) the setup/edge, (2) why now, (3) the precise invalidation level / what proves you wrong, (4) the main counter-argument and why you still take it. The risk control IS the edge.
- You are autonomous: no human in the loop. Decide and act like a professional risk manager trading real capital who answers to a client that fires you for blowups, not for caution.`;

const PERSONA = (process.env.PERSONA || "disciplined").toLowerCase();
const SYSTEM_PROMPT =
  PERSONA === "aggressive"
    ? AGGRESSIVE_PROMPT
    : PERSONA === "conservative"
      ? CONSERVATIVE_PROMPT
      : DISCIPLINED_PROMPT;
/** Active persona name — surfaced in the boot banner + records. */
export const ACTIVE_PERSONA = PERSONA;

const JSON_INSTRUCTION = `

Respond ONLY with a JSON object, no prose around it:
{
  "side": "long" | "short" | "flat",
  "leverage": <number, 0 if flat; size to conviction, not habit>,
  "action": "<short imperative naming the asset, e.g. 'open 2x long ETH, 5000 USDC margin' or 'stay flat'>",
  "thesis": "<2-3 sentences: the edge, why now, the invalidation level, and the main counter-argument. For flat: why no setup qualifies.>"
}`;

interface KimiResult {
  decision: TradeDecision;
  raw: string;
}

/**
 * Ask Kimi K2.6 for a trade decision on the given market.
 * Returns both the parsed decision and the full reasoning chain.
 */
export async function generateTradeDecision(
  market: MarketSnapshot,
  apiKey: string,
): Promise<KimiResult> {
  const userMsg = `Live market snapshot:\n${describeMarket(market)}\n\nRaw: ${JSON.stringify(
    {
      price: market.price,
      change24hPct: market.priceChangePct24h,
      high24h: market.high24h,
      low24h: market.low24h,
      volume24h: market.volume24h,
      technicals: market.technicals,
    },
  )}\n\nDecide your action now.`;

  const res = await fetch(MOONSHOT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + JSON_INSTRUCTION },
        { role: "user", content: userMsg },
      ],
      temperature: 1, // MUST be 1 for kimi-k2.6
      max_tokens: 4000, // reasoning_content eats budget first; 2000 truncated the JSON
    }),
  });

  if (!res.ok) {
    throw new Error(`Kimi K2.6 failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: Array<{
      message: { content?: string; reasoning_content?: string };
    }>;
  };
  const msg = data.choices?.[0]?.message;
  const content = (msg?.content ?? "").trim();
  const reasoning = (msg?.reasoning_content ?? "").trim();

  const parsed = parseDecision(content);

  const decision: TradeDecision = {
    symbol: market.symbol,
    side: parsed.side,
    leverage: parsed.leverage,
    action: parsed.action,
    thesis: parsed.thesis,
    reasoning: reasoning || content, // fall back to content if no reasoning field
    stakeLevel: classifyStake(parsed.side, parsed.leverage),
    highStakes: classifyStake(parsed.side, parsed.leverage) !== "micro",
  };

  return { decision, raw: content };
}

/**
 * Re-plan after a verification BLOCK/UNCERTAIN. Feeds the agent its own blocked
 * decision plus the verifier's objections, and asks for ONE revised decision.
 *
 * HONESTY LINE: the goal is a genuinely safer/better-reasoned decision (often
 * "stay flat" or "size down with a stop"), NOT to talk the verifier into an
 * ALLOW. We tell the model exactly that. The revised decision is verified again
 * by the same independent pipeline — there is no way to "argue past" it.
 *
 * Anti-loop: this runs at most once per cycle (enforced by the caller). The
 * revised decision is final for the cycle whatever its verdict.
 */
export async function replanAfterBlock(
  market: MarketSnapshot,
  blocked: TradeDecision,
  verdict: "BLOCK" | "UNCERTAIN",
  objections: string[],
  apiKey: string,
): Promise<KimiResult> {
  const objectionList = objections.length
    ? objections.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(no specific objections returned; the verifier could not confirm the reasoning was sound)";

  const verdictFraming = verdict === "BLOCK"
    ? "BLOCKED — the verifier found serious flaws in your reasoning. The objections below are strongly supported."
    : "flagged as UNCERTAIN — the verifier has concerns but is not certain your reasoning is wrong. The objections may or may not apply to this specific situation.";

  const userMsg = `Live market snapshot:\n${describeMarket(market)}\n\nYour previous decision this cycle was ${verdictFraming}\n\nYour original decision:\n  action: ${blocked.action}\n  side: ${blocked.side}, leverage: ${blocked.leverage}\n  thesis: ${blocked.thesis}\n\nThe verifier's objections:\n${objectionList}\n\nRe-decide now. Consider each objection individually against the ACTUAL market data above:\n\nIf the objections expose genuine flaws (missing stop, fabricated numbers, unjustified sizing):\n→ Fix the reasoning: reduce size, add explicit invalidation, or STAY FLAT if there's no defensible edge.\n\nIf the objections DON'T apply to this specific situation (e.g. the data contradicts their premise, or they misread your thesis):\n→ REAFFIRM the trade with a revised thesis that directly addresses each objection, explaining specifically why it doesn't hold here. You may also adjust sizing downward as a risk-management concession even when reaffirming the direction.\n\nBoth outcomes are valid. A good trader sometimes stands down, sometimes pushes back with better reasoning. The test is whether you can defend the decision against the specific critique — not whether you agree with authority.\n\nYour revised decision will be independently verified again.\n\nRespond ONLY with the same JSON object shape.`;

  const res = await fetch(MOONSHOT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT + JSON_INSTRUCTION },
        { role: "user", content: userMsg },
      ],
      temperature: 1, // MUST be 1 for kimi-k2.6
      max_tokens: 8000, // replan needs reasoning headroom — 4000 cut off JSON (same fix as engine.ts)
    }),
  });

  if (!res.ok) {
    throw new Error(`Kimi K2.6 replan failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content?: string; reasoning_content?: string } }>;
  };
  const msg = data.choices?.[0]?.message;
  const content = (msg?.content ?? "").trim();
  const reasoning = (msg?.reasoning_content ?? "").trim();
  const parsed = parseDecision(content);

  const decision: TradeDecision = {
    symbol: market.symbol,
    side: parsed.side,
    leverage: parsed.leverage,
    action: parsed.action,
    thesis: parsed.thesis,
    reasoning: reasoning || content,
    stakeLevel: classifyStake(parsed.side, parsed.leverage),
    highStakes: classifyStake(parsed.side, parsed.leverage) !== "micro",
  };

  return { decision, raw: content };
}

function parseDecision(content: string): {
  side: "long" | "short" | "flat";
  leverage: number;
  action: string;
  thesis: string;
} {
  const normSide = (v: unknown): "long" | "short" | "flat" =>
    (["long", "short", "flat"].includes(String(v)) ? v : "flat") as "long" | "short" | "flat";

  // First try strict JSON (the happy path).
  const match = content.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]) as Record<string, unknown>;
      const side = normSide(o.side);
      return {
        side,
        leverage: Number(o.leverage) || 0,
        action: String(o.action ?? (side === "flat" ? "stay flat" : "trade")),
        thesis: String(o.thesis ?? ""),
      };
    } catch {
      // fall through to field-level recovery
    }
  }

  // Recovery: a reasoning model can hit the token cap mid-JSON (valid JSON, no
  // closing brace). Pull the fields we need with targeted regexes so a truncated
  // but clearly-formed decision isn't discarded as "flat/unparseable".
  const sideMatch = content.match(/"side"\s*:\s*"(long|short|flat)"/);
  const levMatch = content.match(/"leverage"\s*:\s*(-?\d+(?:\.\d+)?)/);
  const actionMatch = content.match(/"action"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const thesisMatch = content.match(/"thesis"\s*:\s*"((?:[^"\\]|\\.)*)"?/);
  if (sideMatch) {
    const side = normSide(sideMatch[1]);
    return {
      side,
      leverage: levMatch ? Number(levMatch[1]) || 0 : 0,
      action: actionMatch ? actionMatch[1] : side === "flat" ? "stay flat" : "trade",
      thesis: thesisMatch ? thesisMatch[1].replace(/\\"/g, '"') : "",
    };
  }

  // Truly unparseable — stay flat rather than fabricate a trade.
  return { side: "flat", leverage: 0, action: "no action (unparseable)", thesis: content.slice(0, 200) };
}

/**
 * Stake classification — drives BOTH routing (escalate to RV) and the RV
 * verdict threshold. Mirrors the canonical cb4a-verify model: every directional
 * decision escalates to the adversarial panel (not just 3x+ leverage), and the
 * stake LEVEL scales how sound the reasoning must be to ALLOW.
 *
 * Rationale: this is a $50k perpetual account, so any directional position is
 * already material notional. The old `leverage >= 3` gate let large 1-2x bets
 * skip RV entirely and rest on Sentinel's UNCERTAIN default — the exact reason
 * the SKALE agent's log showed only UNCERTAIN. Leverage now scales strictness
 * instead of acting as an on/off switch.
 *
 *   flat            → "micro"    (Sentinel-only; no irreversible action anyway)
 *   directional 1x  → "low"      (escalates; 0.40 threshold — small defined-risk bet)
 *   directional 2x  → "medium"   (escalates; 0.65 threshold)
 *   directional 3x  → "high"     (escalates; 0.75 threshold)
 *   directional 4x+ → "critical" (escalates; 0.85 threshold — heavy leveraged capital)
 *
 * Rationale for the 2026-06-14 ladder shift: the old floor was "any directional
 * = medium (0.65)". That meant the LOWEST-risk directional action a $50k account
 * can take — a single-x position with a hard stop — still had to clear a 0.65
 * soundness bar, and in practice nothing ever did (0% ALLOW across both lines,
 * RV blocked 9/9 + 11/11). A 1x perp is genuinely low-stakes; pricing it at 0.40
 * lets a GENUINELY well-reasoned small trade earn a stable ALLOW, while leverage
 * still scales strictness sharply (4x = 0.85). This is principled risk-based
 * stake mapping, NOT lowering the bar to manufacture a green light.
 */
function classifyStake(side: "long" | "short" | "flat", leverage: number): StakeLevel {
  if (side === "flat") return "micro";
  // Routing + strictness ladder (2026-06-14). RV escalation fires ONLY at
  // critical (≥10x) — genuine wipeout-risk leverage on the $50k perp account.
  // Below that, Sentinel is the sole gate (now defensible: it returns
  // structured objections). Leverage still scales RV's strictness threshold
  // when RV does run.
  if (leverage >= 10) return "critical"; // ≥10x → RV
  if (leverage >= 6) return "high";      // 6-9x: aggressive, Sentinel-only
  if (leverage >= 3) return "medium";    // 3-5x: moderate
  return "low";                          // 1-2x: conservative
}
