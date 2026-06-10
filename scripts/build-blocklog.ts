// Block-Log builder — the dogfooding showcase artifact.
//
// Reads runs/decisions.jsonl, isolates the BLOCKED leveraged decisions (the
// ones that matter), enriches each with a real-data counterfactual (what the
// trade would have cost), and renders a single self-contained HTML page.
//
// Demo discipline (ThoughtProof): headline = AVOIDED HARM, never returns.
// Every block line carries the signed verdict + objections. RV judges the
// DEFENSIBILITY of the reasoning, not market direction — stated on the page.
//
// Usage:  tsx scripts/build-blocklog.ts [path/to/decisions.jsonl] [out.html]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DecisionRecord } from "../src/types.js";
import {
  estimateCounterfactual,
  ACCOUNT_EQUITY,
  type CounterfactualResult,
} from "../src/counterfactual.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const inPath = resolve(process.argv[2] ?? `${ROOT}/runs/decisions.jsonl`);
const outPath = resolve(process.argv[3] ?? `${ROOT}/runs/block-log.html`);

interface BlockEntry {
  record: DecisionRecord;
  counterfactual: CounterfactualResult | null;
}

function loadRecords(path: string): DecisionRecord[] {
  const raw = readFileSync(path, "utf8");
  const out: DecisionRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as DecisionRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function isBlocked(r: DecisionRecord): boolean {
  return r.verification?.finalVerdict === "BLOCK";
}

async function main() {
  const records = loadRecords(inPath);
  const blocked = records.filter(isBlocked);

  const entries: BlockEntry[] = [];
  for (const record of blocked) {
    const side = record.decision.side;
    const lev = record.decision.leverage;
    let counterfactual: CounterfactualResult | null = null;
    if ((side === "long" || side === "short") && lev > 0) {
      try {
        counterfactual = await estimateCounterfactual(
          record.market.symbol,
          side,
          lev,
          record.market.price,
          record.timestamp,
        );
      } catch (e) {
        console.error(`counterfactual failed for cycle ${record.cycle}:`, e);
      }
    }
    entries.push({ record, counterfactual });
  }

  // Aggregate avoided-harm stats (headline numbers, harm-framed).
  const totalDecisions = records.length;
  const totalBlocks = blocked.length;
  const liquidations = entries.filter((e) => e.counterfactual?.liquidated).length;
  const totalAvoidedUsd = entries.reduce(
    (sum, e) => sum + (e.counterfactual?.avoidedLossUsd ?? 0),
    0,
  );
  const worstSingle = entries.reduce(
    (max, e) => Math.max(max, e.counterfactual?.maxAdverseExcursionPct ?? 0),
    0,
  );

  const html = renderHtml({
    entries,
    totalDecisions,
    totalBlocks,
    liquidations,
    totalAvoidedUsd,
    worstSingle,
    generatedAt: new Date().toISOString(),
  });

  writeFileSync(outPath, html, "utf8");
  console.log(
    `Block-log written: ${outPath}\n` +
      `  decisions: ${totalDecisions} | blocks: ${totalBlocks} | ` +
      `liquidations avoided: ${liquidations} | avoided harm: $${totalAvoidedUsd.toLocaleString()}`,
  );
}

// ─── Rendering ────────────────────────────────────────────────────────────────

interface RenderData {
  entries: BlockEntry[];
  totalDecisions: number;
  totalBlocks: number;
  liquidations: number;
  totalAvoidedUsd: number;
  worstSingle: number;
  generatedAt: string;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortHash(h?: string): string {
  if (!h) return "—";
  return h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h;
}

function renderCounterfactual(c: CounterfactualResult | null): string {
  if (!c) return `<div class="cf cf-na">No counterfactual (non-directional).</div>`;
  if (c.insufficientData) {
    return `<div class="cf cf-pending">⏳ Counterfactual pending — not enough forward price data since the block yet.</div>`;
  }
  const liq = c.liquidated
    ? `<span class="liq">LIQUIDATED ${esc(c.liquidatedAt?.slice(0, 16).replace("T", " "))}</span>`
    : "";
  const harmLine = c.liquidated
    ? `Would have been <b>liquidated</b> — full margin at risk lost (−$${ACCOUNT_EQUITY.toLocaleString()} on this position).`
    : `Worst drawdown: <b>−${c.maxAdverseExcursionPct}%</b> of equity (≈ −$${c.avoidedLossUsd.toLocaleString()}) at $${c.worstPrice.toLocaleString()}.`;
  const honesty = c.wouldHaveProfited
    ? `<div class="cf-honest">⚖︎ Honest note: as it played out, this position would currently be <b>up ${c.pnlNowPct}%</b>. RV blocked it for indefensible <i>reasoning</i> (unbounded risk / no stop / single-indicator), not for predicted direction. The avoided harm is the worst-case exposure it accepted, not a directional call.</div>`
    : "";
  return `
    <div class="cf">
      <div class="cf-head">Counterfactual ${liq} <span class="cf-sim">simulation · paper account · real Binance prices</span></div>
      <div class="cf-body">
        ${harmLine}<br/>
        <span class="muted">${esc(c.side)} ${c.leverage}× from $${c.entryPrice.toLocaleString()} · liquidation at −${c.liquidationThresholdPct}% price move · evaluated over ${c.evaluatedThroughHours}h · now ${c.pnlNowPct >= 0 ? "+" : ""}${c.pnlNowPct}%.</span>
        ${honesty}
      </div>
    </div>`;
}

function renderEntry(e: BlockEntry): string {
  const r = e.record;
  const d = r.decision;
  const rv = r.verification.rv;
  const sent = r.verification.sentinel;
  const objections =
    rv?.objections && rv.objections.length
      ? `<ol class="obj">${rv.objections
          .map((o) => `<li><span class="sev sev-${esc(o.severity)}">${esc(o.severity)}</span> ${esc(o.explanation)}</li>`)
          .join("")}</ol>`
      : `<div class="muted">No objections recorded (decision blocked pre-RV-fix or at Sentinel gate).</div>`;

  const attHash = rv?.attestation?.hash ?? sent?.attestation?.claimHash;
  const attRow = attHash
    ? `<div class="att">🔏 Signed verdict · claim ${esc(shortHash(sent?.attestation?.claimHash))} · evidence ${esc(shortHash(sent?.attestation?.evidenceHash))}${rv?.attestation?.hash ? ` · RV ${esc(shortHash(rv.attestation.hash))}` : ""}</div>`
    : "";

  const conf = rv?.confidence != null ? `${Math.round(rv.confidence * 100)}%` : "—";

  return `
  <article class="block">
    <header>
      <span class="badge badge-block">BLOCK</span>
      <span class="intent">${esc(d.side.toUpperCase())} ${d.leverage}× ${esc(r.market.symbol)} @ $${r.market.price.toLocaleString()}</span>
      <span class="meta">cycle ${r.cycle} · ${esc(r.timestamp.slice(0, 16).replace("T", " "))} · verdict confidence ${conf} · ${rv?.modelCount ?? "?"} models</span>
    </header>
    <div class="thesis"><b>Agent's thesis:</b> ${esc(d.thesis)}</div>
    <div class="why"><b>Why ThoughtProof blocked it:</b>${objections}</div>
    ${renderCounterfactual(e.counterfactual)}
    ${attRow}
  </article>`;
}

function renderHtml(data: RenderData): string {
  const blocksHtml = data.entries.length
    ? data.entries.map(renderEntry).join("\n")
    : `<p class="muted">No blocked decisions yet. The agent is running; blocks appear here as they happen.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Verified Trading Agent — Block Log</title>
<style>
  :root { --bg:#0b0e14; --card:#141925; --line:#222a3a; --txt:#e6e9ef; --muted:#8a93a6; --accent:#5b8cff; --block:#ff5b6e; --ok:#3ecf8e; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:26px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 24px; }
  .stats { display:flex; flex-wrap:wrap; gap:14px; margin:0 0 28px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 18px; flex:1 1 150px; }
  .stat .n { font-size:24px; font-weight:700; }
  .stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .stat.harm .n { color:var(--block); }
  .disclaimer { background:#181d2a; border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:8px; padding:12px 16px; color:var(--muted); font-size:13px; margin:0 0 28px; }
  article.block { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin:0 0 18px; }
  article.block header { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:10px; }
  .badge { font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px; letter-spacing:.05em; }
  .badge-block { background:rgba(255,91,110,.15); color:var(--block); border:1px solid rgba(255,91,110,.4); }
  .intent { font-weight:600; }
  .meta { color:var(--muted); font-size:12px; margin-left:auto; }
  .thesis { margin:8px 0; }
  .why { margin:12px 0; }
  ol.obj { margin:8px 0 0; padding-left:20px; }
  ol.obj li { margin:6px 0; }
  .sev { font-size:10px; font-weight:700; text-transform:uppercase; padding:1px 6px; border-radius:4px; margin-right:6px; }
  .sev-high,.sev-critical { background:rgba(255,91,110,.18); color:var(--block); }
  .sev-medium { background:rgba(91,140,255,.18); color:var(--accent); }
  .sev-low { background:rgba(138,147,166,.18); color:var(--muted); }
  .cf { background:#10131c; border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:12px 0 0; font-size:14px; }
  .cf-head { font-weight:600; margin-bottom:6px; }
  .cf-sim { color:var(--muted); font-weight:400; font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-left:6px; }
  .liq { color:var(--block); font-weight:700; font-size:12px; border:1px solid rgba(255,91,110,.4); padding:1px 6px; border-radius:4px; }
  .cf-honest { margin-top:8px; color:var(--muted); font-size:13px; border-top:1px dashed var(--line); padding-top:8px; }
  .cf-na,.cf-pending { color:var(--muted); }
  .att { margin-top:10px; font-size:12px; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .muted { color:var(--muted); }
  footer { margin-top:40px; color:var(--muted); font-size:12px; text-align:center; }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Verified Trading Agent — Block Log</h1>
  <p class="sub">An autonomous agent (Kimi K2.6) reasons about BTC trades. Before any leveraged position, <b>ThoughtProof verifies the reasoning</b>. These are the decisions it <b>blocked</b> — each with the objections that sank it and a signed verdict.</p>

  <div class="stats">
    <div class="stat"><div class="n">${data.totalDecisions}</div><div class="l">Decisions verified</div></div>
    <div class="stat"><div class="n">${data.totalBlocks}</div><div class="l">Blocked</div></div>
    <div class="stat harm"><div class="n">${data.liquidations}</div><div class="l">Liquidations avoided</div></div>
    <div class="stat harm"><div class="n">$${data.totalAvoidedUsd.toLocaleString()}</div><div class="l">Worst-case harm avoided</div></div>
  </div>

  <div class="disclaimer">
    <b>How to read this.</b> ThoughtProof's RV blocks a decision when its <i>reasoning</i> is indefensible — unbounded risk, no stop-loss, a single-indicator thesis — <b>not</b> because it predicts price direction. Counterfactuals are <b>simulations on a $${ACCOUNT_EQUITY.toLocaleString()} paper account against real Binance prices</b>; no real capital moves. "Harm avoided" is the worst-case exposure each blocked position accepted. Where a blocked trade would have been profitable by luck, we say so — the point is the broken reasoning, not a market call.
  </div>

  ${blocksHtml}

  <footer>
    Generated ${esc(data.generatedAt)} · Verified Trading Agent · ERC-8004 #571 · reasoning by Kimi K2.6, verification by ThoughtProof (Sentinel → RV).
  </footer>
</div>
</body>
</html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
