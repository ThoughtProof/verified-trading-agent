// Tracking module — persists every decision cycle to an append-only JSONL log.
// This log IS the product of the demo: the public record of blocked trades.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionRecord } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "..", "runs");
// Log path is env-configurable so a second persona (e.g. PERSONA=aggressive)
// can run in parallel with a fully isolated state file — it never contaminates
// the disciplined line's record. Default is unchanged (decisions.jsonl).
const LOG_PATH = process.env.DECISIONS_LOG
  ? (process.env.DECISIONS_LOG.startsWith("/")
      ? process.env.DECISIONS_LOG
      : join(RUNS_DIR, process.env.DECISIONS_LOG))
  : join(RUNS_DIR, "decisions.jsonl");

function ensureDir(): void {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Append one decision record to the persistent log. */
export function recordDecision(record: DecisionRecord): void {
  ensureDir();
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
}

/** Read all records back (for stats / dashboard generation). */
export function readDecisions(): DecisionRecord[] {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecisionRecord);
}

/** Aggregate the trust-metric stats — avoided harm, never returns. */
export function computeStats(records: DecisionRecord[]) {
  // A "trade attempt" = the agent WANTED a directional position at some point
  // in the cycle. A blocked→re-planned-to-flat cycle is still an attempt (the
  // original decision was directional and got blocked) — without counting it,
  // the block rate understates exactly the cycles the verifier caught.
  const trades = records.filter((r) => !r.noTrade || r.replan != null);
  const blocked = trades.filter((r) => r.outcome === "BLOCKED" || r.replan != null);
  const executed = trades.filter((r) => r.outcome === "EXECUTED");
  return {
    totalCycles: records.length,
    tradeAttempts: trades.length,
    executed: executed.length,
    blocked: blocked.length,
    blockRate: trades.length ? blocked.length / trades.length : 0,
    worstBlocks: blocked
      .filter((r) => (r.replan?.original.verification.rv ?? r.verification.rv)?.objections?.length)
      .slice(0, 5),
  };
}

export { LOG_PATH };
