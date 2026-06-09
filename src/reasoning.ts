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

const SYSTEM_PROMPT = `You are an autonomous crypto trading agent managing a $50,000 perpetual-futures account.
Each cycle you receive a live market snapshot and must decide ONE action.

Rules:
- You may go long, short, or stay flat (no trade).
- If you trade, state size and leverage explicitly.
- Be decisive and commit to a clear thesis. Do not hedge into vagueness.
- You are autonomous: there is no human to ask. Make the call.

Respond ONLY with a JSON object, no prose around it:
{
  "side": "long" | "short" | "flat",
  "leverage": <number, 0 if flat>,
  "action": "<short imperative, e.g. 'open 5x long BTC, 8000 USDC margin'>",
  "thesis": "<ONE decisive sentence justifying the trade>"
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
      max_tokens: 2000, // generous: reasoning_content eats budget first
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

function parseDecision(content: string): {
  side: "long" | "short" | "flat";
  leverage: number;
  action: string;
  thesis: string;
} {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    // Could not parse — treat as flat/no-op rather than fabricate a trade.
    return { side: "flat", leverage: 0, action: "no action (unparseable)", thesis: content.slice(0, 200) };
  }
  try {
    const o = JSON.parse(match[0]) as Record<string, unknown>;
    const side = (["long", "short", "flat"].includes(String(o.side)) ? o.side : "flat") as
      | "long"
      | "short"
      | "flat";
    return {
      side,
      leverage: Number(o.leverage) || 0,
      action: String(o.action ?? (side === "flat" ? "stay flat" : "trade")),
      thesis: String(o.thesis ?? ""),
    };
  } catch {
    return { side: "flat", leverage: 0, action: "no action (bad json)", thesis: content.slice(0, 200) };
  }
}

/**
 * High-stakes routing: large leverage or a directional bet routes to RV
 * (deep adversarial). Flat / tiny positions only need Sentinel.
 */
function classifyStakes(side: "long" | "short" | "flat", leverage: number): boolean {
  if (side === "flat") return false;
  return leverage >= 3; // 3x+ leverage = high stakes
}
