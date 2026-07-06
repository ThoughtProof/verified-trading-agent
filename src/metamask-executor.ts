// MetaMask Agent Wallet executor — the ThoughtProof × MetaMask integration layer.
//
// WHAT THIS DEMONSTRATES
// ----------------------
// MetaMask Agent Wallet runs a mandatory, non-bypassable security pipeline
// (simulation → Blockaid threat scan → MEV protection → $10k Transaction
// Protection). That pipeline answers "is this transaction MALICIOUS?". It does
// NOT answer "is the DECISION behind it DEFENSIBLE?" — a perfectly safe, non-
// malicious swap can still rest on a hallucinated thesis (wrong asset, invented
// level, no invalidation). MetaMask's own $10k protection explicitly does not
// cover losses from a "safe" transaction that was simply a bad idea.
//
// ThoughtProof sits ONE LAYER ABOVE MetaMask, on the agent side: before the
// agent ever invokes the `mm` CLI, it asks ThoughtProof "is this decision
// defensible?". Only on ALLOW does the agent call `mm perps open`. On BLOCK the
// `mm` command is NEVER constructed — the transaction never enters MetaMask's
// pipeline at all. This is Layer 5 (Decision Quality) composing cleanly with
// MetaMask's Layer 2/3 (execution + security), with zero changes required to
// MetaMask: the integration lives in the agent that drives the wallet.
//
// EXECUTION MODES (env MM_EXECUTION_MODE)
//   off    — default. No MetaMask involvement; legacy simulated execution.
//   dryrun — build the exact `mm perps` command for an ALLOWed decision. If the
//            `mm` binary is installed AND logged in, run the READ-ONLY
//            `mm perps quote` to validate the command against the real SDK.
//            Never runs `mm perps open`. Safe to run without funds.
//   live   — actually run `mm perps open` on ALLOW. Requires `mm login` + funded
//            venue. Guarded; intended to be flipped on by the operator (Raul)
//            with his own Early-Access credentials, never by default.
//
// HONESTY: in dryrun without an installed/authed `mm`, we still PROVE the
// integration shape (the exact command + args) but clearly label that the SDK
// call was not exercised. We never fabricate a quote/fill.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TradeDecision, MarketSnapshot, Verdict } from "./types.js";

const execFileAsync = promisify(execFile);

export type ExecutionMode = "off" | "dryrun" | "live";

export function getExecutionMode(): ExecutionMode {
  const m = (process.env.MM_EXECUTION_MODE ?? "off").toLowerCase();
  return m === "dryrun" || m === "live" ? m : "off";
}

// Venue + network config. Hyperliquid is what `mm perps` trades. NETWORK
// defaults to `testnet` — a live end-to-end run against MetaMask's real rails
// with worthless testnet funds, no real capital at risk. Set
// MM_PERPS_NETWORK=mainnet only for a deliberate real-money run.
const MM_VENUE = process.env.MM_PERPS_VENUE ?? "hyperliquid";
const MM_NETWORK = (process.env.MM_PERPS_NETWORK ?? "testnet").toLowerCase() === "mainnet" ? "mainnet" : "testnet";
const MM_BIN = process.env.MM_BIN ?? "mm";

export interface MmCommand {
  /** The binary (always `mm`). */
  bin: string;
  /** Full argument vector, ready for execFile (no shell, no injection). */
  args: string[];
  /** Human-readable command string for logs/demos. */
  pretty: string;
}

export interface ExecutionResult {
  mode: ExecutionMode;
  /** Did the verdict permit execution at all? */
  allowed: boolean;
  /** The mm command that maps to this decision (null if not directional). */
  command: MmCommand | null;
  /** What actually happened. */
  status:
    | "blocked-before-mm" // verdict != ALLOW → mm never invoked (the headline)
    | "command-built" // dryrun, mm not available → command shown, SDK not hit
    | "quoted" // dryrun, mm available → read-only quote succeeded
    | "quote-failed" // dryrun, mm available → quote errored (reported honestly)
    | "executed" // live → mm perps open returned
    | "execute-failed" // live → mm perps open errored
    | "skipped-flat" // agent chose flat; nothing to do
    | "disabled"; // MM_EXECUTION_MODE=off
  /** Raw stdout/stderr from any real `mm` invocation (null if none). */
  output: string | null;
  /** Short note for the demo log. */
  note: string;
}

/**
 * Map a directional TradeDecision to an `mm perps` command. Returns null for
 * flat. Size is derived from leverage as a notional fraction of the configured
 * margin budget — kept conservative; the point is command SHAPE, not sizing.
 */
export function buildMmCommand(
  decision: TradeDecision,
  market: MarketSnapshot,
  sub = "open",
): MmCommand | null {
  if (decision.side === "flat") return null;
  // Symbol normalisation: agent uses "BTCUSDT"/"PEPE/WETH"; perps venues want a
  // bare base symbol (e.g. "BTC"). Strip common quote suffixes / pool notation.
  const base = normaliseSymbol(market.symbol);
  // `mm perps` wants --size in the BASE ASSET (human-readable, e.g. 0.01 BTC),
  // NOT notional USD. Convert: notional budget × leverage / price.
  const size = String(perpsBaseSize(decision.leverage, market.price));
  const leverage = String(Math.max(1, Math.round(decision.leverage)));
  const args = [
    "perps",
    sub,
    "--venue",
    MM_VENUE,
    "--symbol",
    base,
    "--side",
    decision.side, // "long" | "short"
    "--size",
    size,
    "--leverage",
    leverage,
    "--network",
    MM_NETWORK,
    "--json",
  ];
  return {
    bin: MM_BIN,
    args,
    pretty: `${MM_BIN} ${args.join(" ")}`,
  };
}

function normaliseSymbol(sym: string): string {
  // DEX pool "PEPE/WETH" → "PEPE"; CEX "BTCUSDT" → "BTC".
  const upper = sym.toUpperCase();
  if (upper.includes("/")) return upper.split("/")[0];
  for (const q of ["USDT", "USDC", "BUSD", "USD"]) {
    if (upper.endsWith(q) && upper.length > q.length) return upper.slice(0, -q.length);
  }
  return upper;
}

// Position size in the BASE ASSET as a function of conviction (leverage) and
// price. Deliberately small, fixed-budget — this is a demo of the gate, not a
// sizing strategy. notional = MARGIN_BUDGET × leverage; base size = notional / price.
// Rounded to 4 dp (fine for testnet). Falls back to a tiny size if price is 0.
function perpsBaseSize(leverage: number, price: number): number {
  const MARGIN_BUDGET = Number(process.env.MM_MARGIN_BUDGET_USD ?? 100);
  const lev = Math.max(1, Math.round(leverage));
  const notional = MARGIN_BUDGET * lev;
  if (!price || price <= 0) return 0.001;
  const raw = notional / price;
  // 4 significant-ish decimals; never emit 0 for a real notional.
  const rounded = Math.round(raw * 1e4) / 1e4;
  return rounded > 0 ? rounded : 0.0001;
}

/** Is the `mm` binary installed and authenticated? Cheap, cached per process. */
let _mmStatus: { available: boolean; authed: boolean } | null = null;
export async function probeMm(): Promise<{ available: boolean; authed: boolean }> {
  if (_mmStatus) return _mmStatus;
  try {
    // `mm auth status --json` exits non-zero if not logged in but proves the bin
    // exists. We split availability (bin runs) from authed (logged in).
    const { stdout } = await execFileAsync(MM_BIN, ["auth", "status", "--json"], {
      timeout: 8000,
    });
    let authed = false;
    try {
      const j = JSON.parse(stdout);
      authed = Boolean(j.authenticated ?? j.loggedIn ?? j.status === "authenticated");
    } catch {
      authed = /authenticated|logged.?in/i.test(stdout);
    }
    _mmStatus = { available: true, authed };
  } catch (err: unknown) {
    // ENOENT = not installed. Any other error = installed but `auth status`
    // failed (treat as available, not authed).
    const code = (err as { code?: string }).code;
    _mmStatus = { available: code !== "ENOENT", authed: false };
  }
  return _mmStatus;
}

/**
 * The integration point. Given the final verdict + decision, decide what to do
 * with MetaMask Agent Wallet. This is what main.ts calls in place of the bare
 * "[SIMULATED]" log on the ALLOW path.
 */
export async function executeViaMetaMask(
  verdict: Verdict,
  decision: TradeDecision,
  market: MarketSnapshot,
): Promise<ExecutionResult> {
  const mode = getExecutionMode();

  if (mode === "off") {
    return result(mode, false, null, "disabled", null, "MetaMask execution disabled (MM_EXECUTION_MODE=off).");
  }

  if (decision.side === "flat") {
    return result(mode, false, null, "skipped-flat", null, "Agent stayed flat — no MetaMask call.");
  }

  // THE HEADLINE: verdict gates whether mm is touched at all.
  if (verdict !== "ALLOW") {
    const wouldHave = buildMmCommand(decision, market);
    return result(
      mode,
      false,
      wouldHave,
      "blocked-before-mm",
      null,
      `🛑 ThoughtProof ${verdict} → \`mm perps open\` was NEVER invoked. The transaction never entered MetaMask's pipeline. Blocked one layer before execution.`,
    );
  }

  // ALLOW path: build the real command.
  const cmd = buildMmCommand(decision, market);
  if (!cmd) {
    return result(mode, true, null, "skipped-flat", null, "No directional command to build.");
  }

  const mm = await probeMm();

  if (mode === "dryrun") {
    if (!mm.available) {
      return result(
        mode,
        true,
        cmd,
        "command-built",
        null,
        `✅ ALLOW → would run: ${cmd.pretty}\n   (mm CLI not installed here — command shape validated, SDK not exercised.)`,
      );
    }
    if (!mm.authed) {
      return result(
        mode,
        true,
        cmd,
        "command-built",
        null,
        `✅ ALLOW → would run: ${cmd.pretty}\n   (mm CLI present but not logged in — run \`mm login\`; SDK not exercised.)`,
      );
    }
    // mm available + authed: run the READ-ONLY quote to validate against the real SDK.
    const quoteCmd = buildMmCommand(decision, market, "quote")!;
    try {
      const { stdout, stderr } = await execFileAsync(quoteCmd.bin, quoteCmd.args, { timeout: 20000 });
      return result(
        mode,
        true,
        cmd,
        "quoted",
        (stdout || stderr || "").trim().slice(0, 2000),
        `✅ ALLOW → real \`mm perps quote\` succeeded against the SDK (read-only). Live would run: ${cmd.pretty}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return result(
        mode,
        true,
        cmd,
        "quote-failed",
        msg.slice(0, 2000),
        `✅ ALLOW, but \`mm perps quote\` errored (reported honestly, not hidden): ${msg.slice(0, 200)}`,
      );
    }
  }

  // mode === "live": actually open the position. Guard hard.
  if (!mm.available || !mm.authed) {
    return result(
      mode,
      true,
      cmd,
      "execute-failed",
      null,
      `LIVE requested but mm ${!mm.available ? "not installed" : "not logged in"} — refusing to claim execution. Command was: ${cmd.pretty}`,
    );
  }
  try {
    // `mm perps open` prompts for confirmation interactively; in an autonomous
    // loop we must pass --yes. Appended only on the live exec, never on the
    // read-only quote or the pretty display command.
    const liveArgs = [...cmd.args, "--yes"];
    const { stdout, stderr } = await execFileAsync(cmd.bin, liveArgs, { timeout: 60000 });
    return result(mode, true, cmd, "executed", (stdout || stderr || "").trim().slice(0, 4000), `✅ ALLOW → executed via MetaMask (${MM_NETWORK}): ${cmd.pretty} --yes`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return result(mode, true, cmd, "execute-failed", msg.slice(0, 4000), `Execution via mm failed: ${msg.slice(0, 200)}`);
  }
}

function result(
  mode: ExecutionMode,
  allowed: boolean,
  command: MmCommand | null,
  status: ExecutionResult["status"],
  output: string | null,
  note: string,
): ExecutionResult {
  return { mode, allowed, command, status, output, note };
}
