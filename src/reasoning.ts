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

import type { MarketSnapshot, TradeDecision } from "./types.js";
import { describeMarket } from "./signal.js";

const MOONSHOT_URL = "https://api.moonshot.ai/v1/chat/completions";
const MODEL = "kimi-k2.6";

const SYSTEM_PROMPT = `You are an autonomous crypto trader managing a $50,000 perpetual-futures account. Your job is to grow the account through skilled trading while managing risk. You are judged on your results over time.

Each cycle you receive a live market snapshot and decide ONE action.

How you operate:
- Take a position when you see an edge; stay flat when you genuinely don't. You are not rewarded for activity, but a trader who never trades never grows the account — when the market offers you a real opportunity, take it. Trade the setups you actually see.
- Read the market across multiple factors — price level, momentum, trend structure, volume, range position — and weigh them together. The strongest entries come from confluence, but you are the trader: if your read gives you conviction, act on it.
- Size leverage to conviction: speculative idea → small size or flat; solid setup with clear invalidation → 2-3x; reserve higher leverage for genuinely strong, well-evidenced setups.
- For any position, have a thesis: (1) the setup/edge, (2) why now, (3) the invalidation level / what would prove you wrong, (4) the main counter-argument. If you truly have no view, flat is a legitimate choice — but don't hide behind it when you actually see something.
- You are autonomous: there is no human in the loop and no one second-guessing your call before it executes. Decide and act like a professional trading real capital.

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
        { role: "system", content: SYSTEM_PROMPT },
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
    highStakes: classifyStakes(parsed.side, parsed.leverage),
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

  const userMsg = `Live market snapshot:\n${describeMarket(market)}\n\nYour previous decision this cycle was ${verdict} by the independent verification layer.\n\nYour blocked decision:\n  action: ${blocked.action}\n  side: ${blocked.side}, leverage: ${blocked.leverage}\n  thesis: ${blocked.thesis}\n\nThe verifier's objections:\n${objectionList}\n\nRe-decide ONCE, now. Treat the objections as a skeptical risk committee's findings: either FIX the reasoning (e.g. size down, add an explicit invalidation/stop, wait for confluence) or — if the objections show there is no defensible edge — STAY FLAT. Staying flat is a perfectly good answer; do not force a trade to "win" the re-decision. You are NOT trying to convince the verifier; you are trying to make the decision a professional could defend. Your revised decision will be independently verified again.\n\nRespond ONLY with the same JSON object shape.`;

  const res = await fetch(MOONSHOT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      temperature: 1, // MUST be 1 for kimi-k2.6
      max_tokens: 4000, // replan reasons more; needs headroom so the JSON isn't cut off
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
    highStakes: classifyStakes(parsed.side, parsed.leverage),
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
 * High-stakes routing: large leverage or a directional bet routes to RV
 * (deep adversarial). Flat / tiny positions only need Sentinel.
 */
function classifyStakes(side: "long" | "short" | "flat", leverage: number): boolean {
  if (side === "flat") return false;
  return leverage >= 3; // 3x+ leverage = high stakes
}
