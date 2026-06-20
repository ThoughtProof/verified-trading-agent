# Sentinel Verified Agents — Trading & Wallet, side by side

> Two autonomous agents. One verification primitive. The thesis is not "our
> agent is smart" — it's **"an autonomous agent should not act on an unverified
> decision,"** and ThoughtProof Sentinel is the gate that enforces it.

This doc is the shared top-level map for the two reference agents:

- **[`verified-trading-agent`](https://github.com/ThoughtProof/verified-trading-agent)** — gates *trading decisions*.
- **[`verified-wallet-agent`](https://github.com/ThoughtProof/verified-wallet-agent)** — gates *wallet actions*.

They are deliberately matched: same backend, same fail-closed contract, same
"verdicts are real, never hand-set" discipline — pointed at two different danger
classes.

---

## The one idea

Most agent security answers **"is this transaction safe to sign?"** — simulation,
threat-scanning, MEV protection. That is necessary and it is not what Sentinel does.

Sentinel answers the question that sits *one level up*:

> **Does the decision behind this action actually hold — and is the action the
> user actually authorized?**

A transaction can be perfectly valid, pass every simulator, be *honestly* reasoned
by the agent — and still be wrong, because the **reasoning is indefensible** or the
**action exceeds the mandate**. That gap is invisible to transaction-layer security.
It is the only thing these two agents are built to close.

---

## Two axes of the same primitive

| | verified-trading-agent | verified-wallet-agent |
|---|---|---|
| **What the agent does** | reasons over live market data, decides long/short/flat | proposes on-chain actions (approve / transfer / permit / bridge / swap) |
| **Sentinel mode** | `trade_execution` (+ `RV` adversarial for high-stakes) | `action_authorization` (ADR-0019) |
| **Verification axis** | **faithfulness** — does the claim follow from the evidence? | **authorization** — is the action in-scope and minimally scoped to the mandate? |
| **Catches** | hallucinated / fabricated / indefensible theses | honest-but-over-scoped actions (unlimited approval, injected recipient, amount overshoot, blanket permit, rogue bridge) |
| **Blast radius if it slips** | one bounded position | **the entire wallet** |
| **Agent model** | Kimi K2.6 (outside the RV panel — no self-judging) | model-agnostic; the gate sits in front of any signing agent |
| **Execution** | always **simulated** — no capital, no return claims | **fail-closed signing gate** — only ALLOW reaches the signer |

Same shape, two questions: *"is the reasoning defensible?"* (trading) and *"is the
action authorized?"* (wallet). Together they cover the two ways an autonomous agent
hurts you: it can be **wrong**, or it can be **over-scoped**.

---

## The shared contract (identical in both repos)

- **Fail-closed.** Only an explicit **ALLOW** lets the agent act. **BLOCK** *and*
  **UNCERTAIN** stop the autonomous path. UNCERTAIN is not a soft pass — it is an
  explicit **human-in-the-loop** verdict (in wallet: the signature is never
  produced; in trading: the trade is never sent).
- **Verdicts are real.** Every verdict in every demo and suite comes from a live
  Sentinel API call. No hand-set ALLOW/BLOCK anywhere in either repo.
- **Attested, not asserted.** Each verdict carries Sentinel's cryptographic
  attestation (claim hash, evidence hash, schema UID) — anchored, auditable.
- **We don't modify the wallet / exchange.** No hook inside MetaMask's pipeline,
  no privileged exchange access. The gate lives in the agent that drives the
  account. It is additive: it can only *add* a block, never weaken existing
  transaction security.
- **No fabricated success.** Trading execution is simulated and labeled as such;
  wallet "live" signing requires the operator to wire a concrete signer. Neither
  repo ever fakes a broadcast or a fill.

---

## Where the honesty shows

Both repos report what *fails*, not just what passes — that is the point of a trust
demo.

- **Trading:** RV judges the *defensibility of the reasoning*, not market direction.
  We never claim profit. The metric is **avoided harm**: "the agent wanted N trades,
  Sentinel blocked M, here's why."
- **Wallet:** A 10-run validation snapshot (2026-06-20) exposed that the LLM-only
  path leaks the unlimited-permit vector ~1-in-10 (`drain-04`, 1 false ALLOW / 10) —
  a 3-run smoke test had missed it. We publish the leak rather than hide it, and map
  it to the **deterministic gate** (sentinel PR #5) that hard-BLOCKs that exact
  vector via `unlimited_approval` *before* the LLM runs. The architectural claim is
  the honest one: **the LLM layer is strong but not airtight at the boundary; the
  deterministic layer is.**

---

## Why this doubles the leverage

A reviewer (MetaMask, Coinbase, an exchange, a wallet team) who lands on either repo
sees one agent. This doc connects them into a single proposition:

> **ThoughtProof verifies the *decision*, not just the *transaction* — across both
> the reasoning axis (trading) and the authorization axis (wallet), with the same
> fail-closed, attested, no-fake-results contract.**

That is the strategic surface: not "we built a trading bot" or "we built a wallet
guard," but **a verification layer that any autonomous agent — trading, wallet, or
beyond — can sit behind.**

---

_ThoughtProof — verify the decision, not just the transaction._
