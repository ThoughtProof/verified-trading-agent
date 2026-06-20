# ThoughtProof × MetaMask Agent Wallet — Integration

**Status:** Working integration layer + standalone demo. Dry-run verified against
the real `@metamask/agentic-cli` (v0.4.0). Live execution gated behind operator
login. Built 2026-06-11, ahead of the MetaMask Early-Access kick-off. Extended
2026-06-20 with the `action_authorization` mode + deterministic gate for
wallet-drain vectors (see final section, ADR-0019 / PR #5).

## The one-sentence pitch

MetaMask Agent Wallet answers *"is this transaction malicious?"* (simulation →
Blockaid → MEV protection → $10k cover). ThoughtProof answers *"is this decision
**defensible**?"* — and sits one layer above, on the agent side, so a hallucinated
trade is stopped **before** it ever reaches MetaMask's pipeline.

## How it works

The integration does **not** modify MetaMask and does **not** require a hook
inside MetaMask's (non-bypassable) pipeline — there isn't one, by design. Instead
the gate lives in the agent that drives the `mm` CLI:

```
decision = agent.reason(market)          # Kimi K2.6
verdict  = thoughtproof.verify(decision) # Sentinel / RV  ← Layer 5
if verdict == ALLOW:
    mm perps open --venue hyperliquid ... # MetaMask Layer 2/3 executes
else:
    # `mm` is NEVER invoked. The tx never enters MetaMask's pipeline.
    log.block(decision, verdict)
```

This is Layer 5 (Decision Quality) composing cleanly with MetaMask's Layer 2/3
(execution + Blockaid security). Zero changes to MetaMask required.

## Files

- `src/metamask-executor.ts` — the integration layer. Maps a verified
  `TradeDecision` to an `mm perps` command. Three modes via `MM_EXECUTION_MODE`:
  - `off` (default) — no MetaMask involvement; legacy simulated execution.
  - `dryrun` — on ALLOW, builds the exact `mm perps open` command and, if `mm`
    is installed + logged in, runs the **read-only** `mm perps quote` to validate
    against the real SDK. Never runs `mm perps open`.
  - `live` — runs `mm perps open` on ALLOW. Requires `mm login` + a funded venue.
    Intended to be flipped on by the operator with their own EA credentials.
- `scripts/demo-metamask-integration.ts` — standalone proof. Feeds one
  defensible + one indefensible decision through the executor and shows the
  headline: BLOCK suppresses the `mm` call entirely.
- Wired into `src/main.ts` step 4b — every directional decision in the live loop
  now also runs the executor (no-op when `MM_EXECUTION_MODE=off`).

## Run the demo

```bash
# Command-shape proof (works without mm login):
MM_EXECUTION_MODE=dryrun npx tsx scripts/demo-metamask-integration.ts

# Real read-only SDK validation (needs `mm login` with an EA account):
mm login
MM_EXECUTION_MODE=dryrun npx tsx scripts/demo-metamask-integration.ts
```

## Verified command mapping

The executor builds commands matching the real `mm perps` signature
(confirmed against `mm perps quote --help`, agentic-cli v0.4.0):

```
mm perps open  --venue hyperliquid --symbol <BASE> --side long|short --size <N> --leverage <N> --json
mm perps quote --venue hyperliquid --symbol <BASE> --side long|short --size <N> --leverage <N> --json
```

Symbol normalisation handles the agent's `BTCUSDT` / `PEPE/WETH` → bare base
`BTC` / `PEPE`.

## To go live (operator steps)

1. `mm login` (QR / Google / email) with the Early-Access account.
2. `mm perps deposit --venue hyperliquid --amount <N>` (sources USDC from Arbitrum).
3. `MM_EXECUTION_MODE=live` on a small budget. The BLOCK invariant still holds:
   indefensible decisions never reach `mm perps open`.

## Honesty notes (for the kick-off conversation)

- There is **no documented external pre-hook / middleware** in MetaMask's TX
  pipeline today. The clean integration point is the agent layer, above `mm`.
  An open question for the MetaMask team: *is a native reasoning/attestation
  hook on the roadmap, or does this stay agent-side?*
- `mm perps quote` is auth-gated (returns `AUTH_FAILED` without `mm login`), so
  the real SDK call requires the operator's credentials. The executor reports
  this honestly rather than faking a quote.
- The demo's verdicts are hand-set (ALLOW/BLOCK) to show both paths
  deterministically. In the live loop the verdict comes from real ThoughtProof
  Sentinel/RV calls.

## Beyond perps: `action_authorization` for wallet-drain vectors (ADR-0019)

The perps integration above is the *trading* slice. The higher-value wallet
primitive is **`action_authorization`** — Sentinel's sixth mode — which catches
the honest-but-over-scoped actions that faithfulness checks and Blockaid both
pass. The axis is **action ↔ mandate**, not claim ↔ evidence: is this the
minimal, in-scope execution of the authority the user actually granted?

Validated against five drain vectors (live API, 5 runs each, 25 calls):
**BLOCK 5/5 on every vector, 0 false ALLOWs.**

| Drain vector | Blockaid | action_authorization |
|---|---|---|
| `approve(router, MAX_UINT256)` (honest "saves gas") | pass | BLOCK |
| Prompt-injected recipient | pass | BLOCK |
| Amount overshoot (200 → 2,000) | pass | BLOCK |
| Malicious blanket permit | pass | BLOCK |
| Bridge to unknown chain | pass | BLOCK |

The same gate shape applies: the agent proposes an action, Sentinel verifies it
in `action_authorization` mode **before** `mm` is invoked; on BLOCK the action
never reaches MetaMask's pipeline.

**Deterministic backstop.** The arithmetic overshoot vector (200 vs 2,000) is
quantitative, and LLMs are non-deterministic on arithmetic. A deterministic gate
(`thoughtproof-sentinel/src/engine/authorization-gate.ts`, the same
neuro-symbolic split as the CB4A fact-checker) hard-checks amount / recipient /
allowance violations *before* the LLM when the caller supplies a machine-readable
mandate. Ships **shadow-mode first** (logs, does not gate); can only *add* blocks
on unambiguous violations, never a false ALLOW. See ADR-0019 in the
`thoughtproof-sentinel` repo (PR #5).

**Request shape (action_authorization):**

```jsonc
POST /sentinel/verify
{
  "mode": "action_authorization",
  "claim": "Granting an exact-amount approval of 200 USDC to the Uniswap router to execute the swap the user requested.",
  "evidence": "MANDATE: user instructed 'swap 200 USDC for ETH on Uniswap'. ACTION: approve(0xUniswapRouter, 200 USDC). REASONING: ...",
  "tier": "standard",
  // optional machine-readable mandate → deterministic gate:
  "mandate": {
    "granted": { "maxAmount": 200, "asset": "USDC", "recipient": "0xUniswapRouter", "allowUnlimited": false },
    "action":  { "amount": 200, "asset": "USDC", "recipient": "0xUniswapRouter", "allowance": 200 }
  },
  "gateMode": "shadow"  // 'enforce' to let the gate hard-BLOCK
}
```
