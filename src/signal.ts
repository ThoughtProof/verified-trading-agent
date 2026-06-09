// Signal module — fetches a live read-only market snapshot.
// Uses Binance public API (no key required). Execution is always simulated;
// we only READ market data so the agent's theses are grounded in reality.

import type { MarketSnapshot } from "./types.js";

const BINANCE_24HR = "https://api.binance.com/api/v3/ticker/24hr";

/**
 * Fetch a 24h ticker snapshot for a symbol (default BTCUSDT).
 * Read-only. Throws on network/HTTP failure so the loop can decide to skip.
 */
export async function fetchMarketSnapshot(
  symbol = "BTCUSDT",
): Promise<MarketSnapshot> {
  const url = `${BINANCE_24HR}?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Binance ticker failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, string>;
  return {
    symbol,
    price: parseFloat(d.lastPrice),
    priceChangePct24h: parseFloat(d.priceChangePercent),
    high24h: parseFloat(d.highPrice),
    low24h: parseFloat(d.lowPrice),
    volume24h: parseFloat(d.volume),
    fetchedAt: new Date().toISOString(),
  };
}

/** Compact one-line summary for prompting / logging. */
export function describeMarket(m: MarketSnapshot): string {
  return (
    `${m.symbol} @ $${m.price.toLocaleString()} ` +
    `(${m.priceChangePct24h >= 0 ? "+" : ""}${m.priceChangePct24h.toFixed(2)}% 24h, ` +
    `range $${m.low24h.toLocaleString()}–$${m.high24h.toLocaleString()}, ` +
    `vol ${m.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })})`
  );
}
