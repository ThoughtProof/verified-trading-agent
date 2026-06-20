# Verified Trading Agent

An autonomous crypto trading agent that **verifies every decision through [ThoughtProof](https://thoughtproof.ai) before acting.**

> We let an AI agent trade autonomously. ThoughtProof stops it from blowing up. Here's the receipt.

> 📋 **Start here:** [**Sentinel Verified Agents — Trading & Wallet, side by side**](docs/sentinel-verified-agents.md)
> — the shared map for this repo and its wallet counterpart, and why they pair.

## What this is

Most agentic-trading demos show you a bot that (claims to) make money. This one is the opposite. It demonstrates the thing the whole category is missing: **trust.**

- A real reasoning model ([Kimi K2.6](https://www.moonshot.ai)) acts as an autonomous trading agent on live market data.
- Before any trade executes, the decision passes through ThoughtProof verification:
  - **Sentinel** — fast pre-execution gate on every action (`trade_execution` mode, ~3s)
  - **RV** — adversarial multi-model critique for high-stakes decisions (~50s)
- Trades whose **reasoning doesn't hold get blocked** — and every block is logged with the agent's full reasoning chain and a verifiable verdict.

## The honesty line (non-negotiable)

- We do **not** promise profits. We do not claim the agent "trades well."
- RV judges the **defensibility of the reasoning**, not market direction.
- We demonstrate **avoided harm**: "the agent wanted N trades, ThoughtProof blocked M, here's why."
- Execution is **always simulated** — no real capital, no return claims.
- **Fail-closed:** ALLOW executes (simulated); BLOCK *or* UNCERTAIN means the trade is not sent. We never act on an unresolved verdict.
- Every block carries Sentinel's **cryptographic attestation** (claim hash, evidence hash, schema UID) — the verdict is anchored, not asserted.

> **Known limitation (Phase 1):** the RV `/v1/check` endpoint returns a verdict + model count but not the detailed objection list on this key/tier. The rich "why" currently comes from Sentinel's reasoning + attestation. Surfacing RV objections is tracked for Phase 2.

## Why these specific choices

- **Kimi K2.6 as the agent, not the verifier.** ThoughtProof's RV panel uses Grok, DeepSeek, Gemini, Sonnet. Using any of those as the trading agent would let a model judge itself (circularity). Kimi (Moonshot) sits cleanly outside the panel. And it's a strong, widely-used model — so blocks can't be dismissed as "they used a dumb agent" (no strawman).
- **Live market data, simulated execution.** Each cycle the agent scans the full Binance USDT spot universe for relative strength + breakout structure (filtering out illiquid pumps, stablecoins, and leveraged tokens), and on a configurable cadence also probes the on-chain DEX tail via GeckoTerminal (trending pools across Solana/ETH/BSC/Base — where outsized gains *and* the real danger live: thin liquidity, fresh pools, rugs). It then reasons about the strongest movers — what a real desk does, not a fixed watchlist. DEX tokens carry explicit on-chain risk context (liquidity, pool age) so the agent and verifier can be appropriately skeptical. Theses are grounded in real market data so the blocks are credible; nothing irreversible happens. (Set `SCAN_ENABLED=false` / `DEX_ENABLED=false` to narrow the field.)

## Run it

```bash
cp .env.example .env   # fill in MOONSHOT_API_KEY + THOUGHTPROOF_API_KEY
npm install
npm run demo           # single cycle
npm run loop           # continuous (CYCLE_INTERVAL_SEC between cycles)
```

Every decision is appended to `runs/decisions.jsonl` — the public record.

## Running continuously (30-day autonomous run)

The agent is fully autonomous — no human gives it trade instructions. Kimi
reasons over live market data each cycle and decides long/short/flat on its own.
Execution is always simulated; nothing irreversible happens.

For a durable run, use PM2 (keeps it alive across crashes and reboots):

```bash
pm2 start ecosystem.config.cjs   # starts the loop (CYCLE_INTERVAL_SEC between cycles)
pm2 logs verified-trading-agent  # watch decisions live
pm2 save                         # persist process list
# Reboot survival (run once, needs sudo):
pm2 startup launchd              # prints the sudo command to paste
```

A watchdog (`scripts/watchdog.py`) checks the process is online, not crash-looping,
and producing cycles — staying silent when healthy and alerting only on trouble.

## Architecture

```
fetch market (Binance, read-only)
      │
      ▼
Kimi K2.6 reasons  →  { side, leverage, action, thesis, reasoning }
      │
      ▼
ThoughtProof verify
   ├─ Sentinel (pre-execution gate, always)
   └─ RV (adversarial, high-stakes only)   →  BLOCK > UNCERTAIN > ALLOW
      │
      ▼
ALLOW → execute [SIMULATED]   │   BLOCK → log with reasoning + verdict
      │
      ▼
pot-sdk enrichments
   ├─ @pot-sdk2/polymarket (crowd-intelligence calibration — opt-in, default OFF)
   ├─ @pot-sdk2/friend (persistent memory critic — Phase 2+)
   ├─ @pot-sdk2/graph (knowledge-graph contradictions — Phase 2+)
   └─ @pot-sdk2/pay (x402 payment verification — Phase 3)
      │
      ▼
runs/decisions.jsonl  (the trust record — with enrichments)
      │
      ▼
ERC-8004 giveFeedback (SKALE, zero-gas)  →  on-chain reputation signal
```

## Roadmap

- **Phase 1 (done):** reason → verify → track loop, live against real APIs.
- **Phase 1b (done):** write each verdict on-chain via ERC-8004 `giveFeedback` (SKALE testnet) — turns verdicts into evidence-based agent reputation. Agent #571 registered, feedback from a separate client wallet (contract enforces "Self-feedback not allowed").
- **Phase 2 (polymarket done, friend/graph/pay hooked):** pot-sdk modules integrated into decision loop. `@pot-sdk2/polymarket` is wired and working but **default OFF** (`POLYMARKET_ENABLED=false`) — Polymarket currently has no substantive BTC price-direction markets, so leaving it on just logs "no relevant markets" every cycle. Enable when relevant crypto markets exist or the agent trades Polymarket directly. `friend` (persistent memory critic), `graph` (knowledge-graph contradictions), and `pay` (x402 payment verification) are wired as hooks — activate when LLM provider keys / x402 are configured.

## License

MIT
