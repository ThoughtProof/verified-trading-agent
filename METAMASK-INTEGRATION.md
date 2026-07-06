# ThoughtProof × MetaMask Agent Wallet — Integration

**Status:** Working integration layer + standalone demo. Dry-run verified against
the real `@metamask/agentic-cli` (v0.4.0). Live execution gated behind operator
login. Built 2026-06-11, ahead of the MetaMask Early-Access kick-off.

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
  - `off` (default) — no MetaMask involvement; legacy simulated (paper) execution.
  - `dryrun` — on ALLOW, builds the exact `mm perps open` command and, if `mm`
    is installed + logged in, runs the **read-only** `mm perps quote` to validate
    against the real SDK. Never runs `mm perps open`.
  - `live` — runs `mm perps open --yes` on ALLOW. Requires `mm login` + a funded
    venue. **Defaults to testnet** (`MM_PERPS_NETWORK=testnet`) — a live run
    against MetaMask's real rails with worthless testnet funds, no real capital.
    Set `MM_PERPS_NETWORK=mainnet` only for a deliberate real-money run.
- `scripts/demo-metamask-integration.ts` — standalone proof. Feeds one
  defensible + one indefensible decision through the executor and shows the
  headline: BLOCK suppresses the `mm` call entirely.
- `scripts/verify-mm-command.ts` — quick offline check of the command mapping
  (base-asset size, `--network testnet`, symbol normalisation). No API, no login.
- Wired into `src/main.ts` step 4b — every directional decision in the live loop
  now also runs the executor (no-op when `MM_EXECUTION_MODE=off`).

## Command mapping (verified against agentic-cli v0.4.0, 2026-07-02)

`mm perps open`'s real signature was confirmed via `mm perps open --help`:

```
mm perps open --venue hyperliquid --symbol <BASE> --side long|short \
  --size <BASE_ASSET_AMOUNT> --leverage <N> --network mainnet|testnet [--dry-run] [--yes]
```

Two corrections vs the earlier draft:
- **`--size` is in the BASE ASSET** (human-readable, e.g. `2.4777` SOL), NOT
  notional USD. The executor converts: `MARGIN_BUDGET × leverage / price`.
  (The old code emitted notional USD, which would have failed live.)
- **`--network testnet`** is now always appended; `live` mode adds `--yes` to
  skip the interactive confirmation in the autonomous loop.

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
