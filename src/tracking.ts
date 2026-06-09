// Tracking module — persists every decision cycle to an append-only JSONL log.
// This log IS the product of the demo: the public record of blocked trades.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionRecord } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, "..", "runs");
const LOG_PATH = join(RUNS_DIR, "decisions.jsonl");

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
  const trades = records.filter((r) => !r.noTrade);
  const blocked = trades.filter((r) => r.outcome === "BLOCKED");
  const executed = trades.filter((r) => r.outcome === "EXECUTED");
  return {
    totalCycles: records.length,
    tradeAttempts: trades.length,
    executed: executed.length,
    blocked: blocked.length,
    blockRate: trades.length ? blocked.length / trades.length : 0,
    worstBlocks: blocked
      .filter((r) => r.verification.rv?.objections?.length)
      .slice(0, 5),
  };
}

export { LOG_PATH };
