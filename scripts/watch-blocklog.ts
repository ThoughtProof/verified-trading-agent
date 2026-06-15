// Block-log watcher — rebuilds the HTML showcase whenever the agent writes a
// new decision. Zero cost: only reads the local JSONL and calls Binance's free
// public API (via the builder). No LLM calls, no API fees.
//
// Watches runs/decisions.jsonl; on change, debounces 3s (lets a burst of writes
// settle) then runs the builder. Also does one build on startup so the page is
// fresh the moment the watcher comes up.
//
// Run standalone:  tsx scripts/watch-blocklog.ts
// Or via pm2 (see ecosystem.config.cjs → blocklog-watcher).

import { watch, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const JSONL = resolve(ROOT, "runs/decisions.jsonl");
const BUILDER = resolve(__dirname, "build-block-log-v2.py");
const PYTHON = "python3";
const DEBOUNCE_MS = 3_000;

let timer: NodeJS.Timeout | null = null;
let building = false;
let rebuildQueued = false;

function build(): void {
  if (building) {
    rebuildQueued = true; // a change arrived mid-build; rebuild once more after
    return;
  }
  building = true;
  const proc = spawn(PYTHON, [BUILDER], { cwd: ROOT, stdio: "inherit" });
  proc.on("exit", (code) => {
    building = false;
    console.log(`[watch-blocklog] rebuild done (exit ${code}) @ ${new Date().toISOString()}`);
    if (rebuildQueued) {
      rebuildQueued = false;
      build();
    }
  });
  proc.on("error", (err) => {
    building = false;
    console.error("[watch-blocklog] builder failed to spawn:", err);
  });
}

function scheduleBuild(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(build, DEBOUNCE_MS);
}

function start(): void {
  console.log(`[watch-blocklog] watching ${JSONL}`);
  // Build once on startup.
  build();

  // fs.watch can miss events if the file is replaced; the agent appends, so a
  // plain watch on the file is reliable. We also guard against the file not
  // existing yet (agent hasn't written its first decision).
  const watchTarget = existsSync(JSONL) ? JSONL : dirname(JSONL);
  watch(watchTarget, (_event, filename) => {
    if (!filename || filename.includes("decisions.jsonl")) {
      scheduleBuild();
    }
  });

  // Keep the process alive.
  process.stdin.resume();
}

start();
