# Verified Trading Agent

An autonomous crypto trading agent that **verifies every decision through [ThoughtProof](https://thoughtproof.ai) before acting.**

> We let an AI agent trade autonomously. ThoughtProof stops it from blowing up. Here's the receipt.

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
- **Live market data, simulated execution.** Theses are grounded in real BTC moves so the blocks are credible; nothing irreversible happens.

## Run it

```bash
cp .env.example .env   # fill in MOONSHOT_API_KEY + THOUGHTPROOF_API_KEY
npm install
npm run demo           # single cycle
npm run loop           # continuous (CYCLE_INTERVAL_SEC between cycles)
```

Every decision is appended to `runs/decisions.jsonl` — the public record.

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
runs/decisions.jsonl  (the trust record)
      │
      ▼
ERC-8004 giveFeedback (SKALE, zero-gas)  →  on-chain reputation signal
```

## Roadmap

- **Phase 1 (done):** reason → verify → track loop, live against real APIs.
- **Phase 1b (done):** write each verdict on-chain via ERC-8004 `giveFeedback` (SKALE testnet) — turns verdicts into evidence-based agent reputation. Agent #571 registered, feedback from a separate client wallet (contract enforces "Self-feedback not allowed").
- **Phase 2:** pot-sdk modules — `polymarket` (crowd-intelligence signal), `friend` (persistent memory critic), `graph`, `pay` (x402 payment verification).

## License

MIT
