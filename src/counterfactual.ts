// Counterfactual harm estimation for BLOCKED decisions.
//
// Honesty boundary (matches ThoughtProof demo discipline):
//   - This is a SIMULATION on a paper account. No real capital moves.
//   - RV blocks a decision because its REASONING is indefensible (unbounded
//     risk, no stop, single-indicator thesis), NOT because it predicts the
//     market. A blocked trade may, by luck, have been profitable. We surface
//     that honestly — the point is the broken reasoning and the worst-case
//     exposure it accepted, not "ThoughtProof predicts price".
//   - Headline metric is AVOIDED HARM (worst drawdown / liquidation), never
//     celebrated returns.
//
// Sizing model (explicit, conservative — stated on the page so it's auditable):
//   - Paper account equity: ACCOUNT_EQUITY (default $50,000).
//   - Position notional   = equity × leverage (the agent's stated leverage).
//   - PnL% on equity      = sideSign × (exit/entry − 1) × leverage.
//   - Liquidation         = adverse move reaches ≈ 1/leverage (minus a
//                           maintenance buffer). On liquidation the margin is
//                           lost (−100% of equity at risk in the position).
//
// We walk REAL Binance hourly candles from the block timestamp forward to now
// and report the worst the position would have gotten (max adverse excursion)
// plus where it stands now (or at liquidation).
//
// Known approximation (acceptable, documented): the first hourly candle starts
// at the top of the hour CONTAINING the block timestamp, so up to 59 minutes of
// price action from BEFORE the block can leak into the first candle's high/low.
// On hourly granularity this slightly over- or under-states the worst case by
// at most one candle's intra-hour range — fine for a showcase, not for risk
// accounting. Switch to 1m klines if precision ever matters.

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";

export const ACCOUNT_EQUITY = 50_000;
// Maintenance margin buffer: real exchanges liquidate slightly before the
// naive 1/leverage point. 0.5% buffer keeps the estimate conservative.
const MAINTENANCE_BUFFER = 0.005;

export interface CounterfactualResult {
  /** "long" | "short" — flat decisions are never blocked, so always directional. */
  side: "long" | "short";
  leverage: number;
  entryPrice: number;
  /** ISO time the decision was blocked (position would have opened here). */
  blockedAt: string;
  /** Latest candle close we evaluated against. */
  lastPrice: number;
  evaluatedThroughHours: number;
  /** Worst unrealized loss the position would have hit, in % of equity. */
  maxAdverseExcursionPct: number;
  /** Price at the worst point. */
  worstPrice: number;
  /** Did the position hit liquidation? */
  liquidated: boolean;
  /** ISO time of liquidation, if any. */
  liquidatedAt?: string;
  /** Adverse % move that triggers liquidation for this leverage. */
  liquidationThresholdPct: number;
  /** PnL on equity now (or −100% if liquidated), in %. */
  pnlNowPct: number;
  /** Avoided loss in USD: positive = harm avoided. 0 if the trade would've profited. */
  avoidedLossUsd: number;
  /** Honest note when the blocked trade would have been profitable. */
  wouldHaveProfited: boolean;
  /** True if we had insufficient forward data to evaluate yet. */
  insufficientData: boolean;
}

interface Candle {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

async function fetchHourlyKlines(
  symbol: string,
  startTimeMs: number,
  endTimeMs: number,
): Promise<Candle[]> {
  const url =
    `${BINANCE_KLINES}?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1h&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1000`;
  const res = await fetch(url, {
    headers: { "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`Binance klines failed (${res.status}): ${await res.text()}`);
  }
  const rows = (await res.json()) as unknown[][];
  // Kline: [openTime, open, high, low, close, volume, closeTime, ...]
  return rows.map((r) => ({
    openTime: Number(r[0]),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
  }));
}

/** On-chain pool coordinates for sourcing DEX counterfactual candles. */
export interface DexSource {
  network: string;
  poolAddress: string;
}

/**
 * Fetch hourly OHLCV for a DEX pool from GeckoTerminal and shape it like the
 * Binance candles. Returns candles within [startMs, endMs] (the API returns
 * newest-first; we reverse to chronological and clip to the block window).
 */
async function fetchDexHourlyCandles(
  src: DexSource,
  startTimeMs: number,
  endTimeMs: number,
): Promise<Candle[]> {
  const url = `${GECKOTERMINAL}/networks/${src.network}/pools/${src.poolAddress}/ohlcv/hour?aggregate=1&limit=1000`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "verified-trading-agent/0.1" },
  });
  if (!res.ok) {
    throw new Error(`GeckoTerminal OHLCV failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
  const raw = (body.data?.attributes?.ohlcv_list ?? []).slice().reverse();
  // ohlcv: [tsSeconds, open, high, low, close, volume]
  return raw
    .map((r) => ({
      openTime: Number(r[0]) * 1000,
      high: r[2],
      low: r[3],
      close: r[4],
    }))
    .filter((c) => c.openTime >= startTimeMs && c.openTime <= endTimeMs);
}

/**
 * Simulate the harm a blocked leveraged position would have caused, using real
 * forward price data. Returns null only for non-directional (flat) decisions.
 */
export async function estimateCounterfactual(
  symbol: string,
  side: "long" | "short",
  leverage: number,
  entryPrice: number,
  blockedAtIso: string,
  now: Date = new Date(),
  /** When set, source forward candles from this DEX pool (GeckoTerminal) instead
   * of Binance — the symbol isn't a CEX ticker for on-chain tokens. */
  dexSource?: DexSource,
): Promise<CounterfactualResult> {
  const sideSign = side === "long" ? 1 : -1;
  const liquidationThresholdPct =
    leverage > 0 ? (1 / leverage - MAINTENANCE_BUFFER) * 100 : Infinity;

  const startMs = new Date(blockedAtIso).getTime();
  const endMs = now.getTime();

  const base: CounterfactualResult = {
    side,
    leverage,
    entryPrice,
    blockedAt: blockedAtIso,
    lastPrice: entryPrice,
    evaluatedThroughHours: 0,
    maxAdverseExcursionPct: 0,
    worstPrice: entryPrice,
    liquidated: false,
    liquidationThresholdPct: round(liquidationThresholdPct),
    pnlNowPct: 0,
    avoidedLossUsd: 0,
    wouldHaveProfited: false,
    insufficientData: true,
  };

  const candles = dexSource
    ? await fetchDexHourlyCandles(dexSource, startMs, endMs)
    : await fetchHourlyKlines(symbol, startMs, endMs);
  if (candles.length === 0) {
    return base; // not enough forward data yet (just-blocked decision)
  }

  // Walk forward. For a long, the adverse extreme is the LOW; for a short, HIGH.
  let worstAdversePct = 0;
  let worstPrice = entryPrice;
  let liquidated = false;
  let liquidatedAt: string | undefined;

  for (const c of candles) {
    const adversePrice = side === "long" ? c.low : c.high;
    const adverseMovePct = sideSign * (adversePrice / entryPrice - 1) * 100; // negative = loss
    const adverseLossPct = -adverseMovePct; // positive = how far underwater (price terms)
    if (adverseLossPct > worstAdversePct) {
      worstAdversePct = adverseLossPct;
      worstPrice = adversePrice;
    }
    if (!liquidated && adverseLossPct >= liquidationThresholdPct) {
      liquidated = true;
      liquidatedAt = new Date(c.openTime).toISOString();
    }
  }

  const lastClose = candles[candles.length - 1].close;
  const rawPnlPct = sideSign * (lastClose / entryPrice - 1) * 100 * leverage;
  const pnlNowPct = liquidated ? -100 : rawPnlPct;

  // Max adverse excursion on EQUITY = price-adverse% × leverage, capped at 100%.
  const maxAdverseEquityPct = Math.min(worstAdversePct * leverage, 100);

  // Avoided loss: the worst the position would have been underwater (in $).
  // If liquidated, the full margin at risk is lost.
  const avoidedLossUsd = liquidated
    ? ACCOUNT_EQUITY
    : Math.max(0, (maxAdverseEquityPct / 100) * ACCOUNT_EQUITY);

  const wouldHaveProfited = !liquidated && rawPnlPct > 0;

  const evaluatedThroughHours = Math.round(
    (endMs - candles[0].openTime) / 3_600_000,
  );

  return {
    ...base,
    lastPrice: lastClose,
    evaluatedThroughHours,
    maxAdverseExcursionPct: round(maxAdverseEquityPct),
    worstPrice: round(worstPrice),
    liquidated,
    liquidatedAt,
    pnlNowPct: round(pnlNowPct),
    avoidedLossUsd: Math.round(avoidedLossUsd),
    wouldHaveProfited,
    insufficientData: false,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
