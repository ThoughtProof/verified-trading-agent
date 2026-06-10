// Signal module — fetches a live read-only market snapshot with technical context.
// Uses Binance public API (no key required). Execution is always simulated;
// we only READ market data so the agent's theses are grounded in reality.
//
// We provide more than a 24h snapshot: a multi-day trend, moving-average
// position, RSI, and recent candle structure. A single 24h number can't justify
// a high-conviction trade — real context lets the agent form defensible theses
// (or correctly stay flat), and lets the verifier judge them fairly.

import type { MarketSnapshot, Technicals } from "./types.js";

const BINANCE_24HR = "https://api.binance.com/api/v3/ticker/24hr";
const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";

// ─── Universe scan (active discovery) ─────────────────────────────────────────
// A real trading desk doesn't stare at one chart — it scans the whole market for
// relative strength and breakout structure, THEN reasons about the best
// candidates. This is the difference between "evaluate BTC" and "find what's
// actually moving". The scan is one cheap call (all 24h tickers) + local ranking.

/** A ranked candidate from the universe scan, before deep technical analysis. */
export interface ScanCandidate {
  symbol: string;
  /** 24h price change %. */
  changePct24h: number;
  /** 24h quote (USD) volume — liquidity proxy. */
  quoteVolumeUsd: number;
  /** Position within the 24h range: 0 = at the low, 1 = at the high. */
  rangePosition: number;
  /** Composite rank score (relative strength + breakout proximity). */
  score: number;
}

// Stablecoins and pegged assets — never trade these (no directional edge).
const STABLE_BASES = new Set([
  "USDC", "FDUSD", "TUSD", "DAI", "USDP", "EUR", "BUSD", "AEUR",
  "XUSD", "USD1", "USDE", "GUSD", "PYUSD", "EURI", "USTC",
]);

// Binance leveraged tokens (UP/DOWN/BULL/BEAR) — decaying derivatives, not spot.
function isLeveragedToken(base: string): boolean {
  return base.endsWith("UP") || base.endsWith("DOWN") || base.includes("BULL") || base.includes("BEAR");
}

/**
 * Scan the full Binance USDT spot universe for tradeable candidates.
 *
 * Filters out illiquid pumps (a $0-volume coin up 65% is untradeable, not an
 * opportunity), stablecoins, and leveraged tokens, then ranks survivors by a
 * composite of relative strength (24h change) and breakout proximity (position
 * in the 24h range). Returns the top N for deeper analysis.
 *
 * @param minQuoteVolumeUsd Minimum 24h USD volume to be considered liquid.
 * @param topN How many ranked candidates to return.
 */
export async function scanUniverse(
  minQuoteVolumeUsd = 10_000_000,
  topN = 8,
): Promise<ScanCandidate[]> {
  const res = await fetch(BINANCE_24HR, {
    headers: { "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Binance universe scan failed (${res.status}): ${await res.text()}`);
  }
  const all = (await res.json()) as Array<Record<string, string>>;

  const candidates: ScanCandidate[] = [];
  for (const t of all) {
    const symbol = t.symbol;
    if (!symbol.endsWith("USDT")) continue;
    const base = symbol.slice(0, -4);
    if (STABLE_BASES.has(base) || isLeveragedToken(base)) continue;

    const quoteVolumeUsd = parseFloat(t.quoteVolume);
    if (!Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < minQuoteVolumeUsd) continue;

    const last = parseFloat(t.lastPrice);
    const hi = parseFloat(t.highPrice);
    const lo = parseFloat(t.lowPrice);
    const changePct24h = parseFloat(t.priceChangePercent);
    if (!Number.isFinite(last) || !Number.isFinite(changePct24h)) continue;

    // Position in the 24h range: 1 = printing new highs (breakout), 0 = at lows.
    const rangePosition = hi > lo ? (last - lo) / (hi - lo) : 0.5;

    // Composite: relative strength + a breakout-proximity bonus (being near the
    // high matters; +/-5 points at the extremes). Keeps strong-and-breaking-out
    // names above strong-but-mid-range ones.
    const score = changePct24h + (rangePosition - 0.5) * 10;

    candidates.push({ symbol, changePct24h, quoteVolumeUsd, rangePosition, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topN);
}

/**
 * Fetch a 24h ticker snapshot for a symbol (default BTCUSDT), enriched with
 * multi-day technical context (trend, SMA, RSI, recent candles).
 * Read-only. Throws on network/HTTP failure so the loop can decide to skip.
 */
export async function fetchMarketSnapshot(
  symbol = "BTCUSDT",
): Promise<MarketSnapshot> {
  const [ticker, klines] = await Promise.all([
    fetchTicker(symbol),
    fetchDailyKlines(symbol, 30),
  ]);

  const closes = klines.map((k) => k.close);
  const technicals = computeTechnicals(closes, klines);

  return {
    symbol,
    price: ticker.price,
    priceChangePct24h: ticker.priceChangePct24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    volume24h: ticker.volume24h,
    fetchedAt: new Date().toISOString(),
    technicals,
  };
}

// ─── Ticker ───────────────────────────────────────────────────────────────────

interface Ticker {
  price: number;
  priceChangePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
}

async function fetchTicker(symbol: string): Promise<Ticker> {
  const url = `${BINANCE_24HR}?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Binance ticker failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, string>;
  return {
    price: parseFloat(d.lastPrice),
    priceChangePct24h: parseFloat(d.priceChangePercent),
    high24h: parseFloat(d.highPrice),
    low24h: parseFloat(d.lowPrice),
    volume24h: parseFloat(d.volume),
  };
}

// ─── Klines (daily candles) ─────────────────────────────────────────────────

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchDailyKlines(symbol: string, limit: number): Promise<Candle[]> {
  const url = `${BINANCE_KLINES}?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Binance klines failed (${res.status}): ${await res.text()}`);
  }
  const rows = (await res.json()) as unknown[][];
  // Kline: [openTime, open, high, low, close, volume, ...]
  return rows.map((r) => ({
    open: parseFloat(r[1] as string),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
    volume: parseFloat(r[5] as string),
  }));
}

// ─── Technical Indicators ─────────────────────────────────────────────────────

function computeTechnicals(closes: number[], candles: Candle[]): Technicals {
  const last = closes[closes.length - 1];
  const change7dPct = pctChange(closes, 7);
  const change14dPct = pctChange(closes, 14);
  const sma7 = sma(closes, 7);
  const sma30 = sma(closes, 30);
  const rsi14 = rsi(closes, 14);
  const consecutiveCloses = countConsecutive(candles);
  const trend = classifyTrend(last, sma7, sma30, change7dPct, change14dPct);

  return {
    change7dPct: round(change7dPct),
    change14dPct: round(change14dPct),
    sma7: round(sma7),
    sma30: round(sma30),
    vsSma7: last >= sma7 ? "above" : "below",
    vsSma30: last >= sma30 ? "above" : "below",
    rsi14: round(rsi14),
    consecutiveCloses,
    trend,
  };
}

function pctChange(closes: number[], periods: number): number {
  if (closes.length < periods + 1) return 0;
  const past = closes[closes.length - 1 - periods];
  const now = closes[closes.length - 1];
  return (now / past - 1) * 100;
}

function sma(closes: number[], periods: number): number {
  const slice = closes.slice(-periods);
  if (slice.length === 0) return closes[closes.length - 1] ?? 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Standard Wilder-style RSI over `periods` daily closes. */
function rsi(closes: number[], periods: number): number {
  if (closes.length < periods + 1) return 50; // neutral if insufficient data
  let gains = 0;
  let losses = 0;
  // Seed with first `periods` deltas
  for (let i = closes.length - periods; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / periods;
  const avgLoss = losses / periods;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Count consecutive same-direction daily closes (+ = up streak, - = down streak). */
function countConsecutive(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  let count = 0;
  let dir = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const up = candles[i].close >= candles[i - 1].close;
    const thisDir = up ? 1 : -1;
    if (dir === 0) {
      dir = thisDir;
      count = 1;
    } else if (thisDir === dir) {
      count++;
    } else {
      break;
    }
  }
  return dir * count;
}

function classifyTrend(
  price: number,
  sma7: number,
  sma30: number,
  change7dPct: number,
  change14dPct: number,
): Technicals["trend"] {
  // Strong trends: price + both SMAs aligned and meaningful multi-day move
  if (price > sma7 && sma7 > sma30 && change14dPct > 10) return "strong_uptrend";
  if (price < sma7 && sma7 < sma30 && change14dPct < -10) return "strong_downtrend";
  if (price > sma7 && sma7 > sma30) return "uptrend";
  if (price < sma7 && sma7 < sma30) return "downtrend";
  return "ranging";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Description for prompting / logging ──────────────────────────────────────

/** Compact one-line summary for prompting / logging. */
export function describeMarket(m: MarketSnapshot): string {
  const base =
    `${m.symbol} @ $${m.price.toLocaleString()} ` +
    `(${m.priceChangePct24h >= 0 ? "+" : ""}${m.priceChangePct24h.toFixed(2)}% 24h, ` +
    `range $${m.low24h.toLocaleString()}–$${m.high24h.toLocaleString()}, ` +
    `vol ${m.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })})`;

  const t = m.technicals;
  if (!t) return base;

  const streak =
    t.consecutiveCloses === 0
      ? "no streak"
      : `${Math.abs(t.consecutiveCloses)}d ${t.consecutiveCloses > 0 ? "up" : "down"} streak`;

  return (
    `${base}\n` +
    `Trend: ${t.trend.toUpperCase()} | 7d ${t.change7dPct >= 0 ? "+" : ""}${t.change7dPct}%, 14d ${t.change14dPct >= 0 ? "+" : ""}${t.change14dPct}% | ` +
    `SMA7 $${t.sma7.toLocaleString()} (price ${t.vsSma7}), SMA30 $${t.sma30.toLocaleString()} (price ${t.vsSma30}) | ` +
    `RSI14 ${t.rsi14} ${t.rsi14 > 70 ? "(overbought)" : t.rsi14 < 30 ? "(oversold)" : ""} | ${streak}`
  );
}
