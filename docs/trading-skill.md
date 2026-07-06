# ThoughtProof Trading Skill — Pre-Trade Reasoning Guard

**Status:** Built + dryrun-verified against the real `mm` CLI (`@metamask/agentic-cli` v4.0.0) and the live Sentinel `trade_reasoning` API. This is the trading counterpart to the wallet pre-sign guard.

## What it is

A skill an autonomous trading agent installs and runs **before** it opens a position via the `mm perps` CLI. It wraps ThoughtProof's two-layer verification and turns a proposed trade into an `mm perps open` command — **only on an explicit ALLOW**.

```
decision = agent.reason(market)              # long / short / flat + thesis
verdict  = thoughtproof.verify(decision)     # structural + reasoning  ← THIS SKILL
if verdict == ALLOW:  mm perps open ...       # the venue executes
else:                 mm is NEVER invoked. The order never leaves the agent.
```

## Why a separate skill from the wallet guard (the point)

Wallet-scope checks (unlimited approval, injected recipient, amount overshoot) are **deterministic** — a wallet or CLI can and should build those itself. Trade **reasoning cannot be built deterministically**: whether a thesis is defensible — a hallucinated indicator, an invented price level, data the thesis contradicts, a momentum chase dressed up as analysis — is not a rule check. That is the axis this skill covers, and the reason it is ThoughtProof's rather than something the venue rebuilds.

- **Layer 1 (deterministic, local):** structural fact-check — claimed direction vs the verified window trend, magnitude, range position. Surfaces `structural_fact:` ground truth; never hard-blocks on its own.
- **Layer 2 (Sentinel, `trade_reasoning` mode):** adversarial reasoning verdict against that ground truth. RV escalation is trust-but-verify on high-stakes ALLOWs only.

## API

```typescript
import { runTradeSkill } from "./trade-skill.js";

const result = await runTradeSkill(decision, market, { apiKey });
// result.verification.finalVerdict → ALLOW | BLOCK | UNCERTAIN
// result.execution.status          → executed | quoted | blocked-before-mm | disabled | ...
// result.executed                  → boolean (did the order reach the venue?)
```

## Execution modes (env `MM_EXECUTION_MODE` — identical contract to the wallet skill)

| Mode | Behaviour |
|---|---|
| `off` (default) | Guard evaluates + returns the verdict, never touches `mm`. |
| `dryrun` | On ALLOW, build the exact `mm perps open` command + a read-only `mm perps quote`. No order sent. |
| `live` | On ALLOW, actually open the position. Requires `mm login` + funded wallet. Operator opt-in. |

## Verified behaviour (dryrun, live Sentinel)

| Input | Verdict | `mm` |
|---|---|---|
| Clean 2x long ETH (thesis matches verified SMA/RSI/trend) | **ALLOW** | `mm perps quote` succeeded; would run `mm perps open …` |
| Fabricated 3x short (invented RSI 82, death-cross, SMA200) | **BLOCK** | **never invoked** — blocked one layer before execution |

## Honesty

Fail-closed. BLOCK **and** UNCERTAIN stop the order — UNCERTAIN is not a soft pass, it returns the objections to the agent for a re-plan. On a venue or session hiccup the skill fails closed and never claims a fill that didn't happen. Verdicts are always a live Sentinel call, never hand-set.
