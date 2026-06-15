#!/usr/bin/env python3
"""
SKALE Verified Trading Agent — HTML Log Builder v2

Reads decisions-*.jsonl and generates a compact, filterable dashboard.
Same design language as the CB4A dashboard: table view with expandable detail rows,
verdict timeline, filter bar, and objection pattern aggregation.

Usage:
  python3 scripts/build-block-log-v2.py
  python3 scripts/build-block-log-v2.py --input runs/decisions.jsonl --output runs/block-log.html
"""

import json, glob, os, sys, html
from collections import Counter
from pathlib import Path

RUNS_DIR = Path(__file__).resolve().parent.parent / "runs"

def load_decisions(*paths):
    rows = []
    for p in paths:
        if not os.path.exists(p):
            continue
        with open(p) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows

def classify_persona(path):
    bn = os.path.basename(path)
    if 'aggressive' in bn:
        return 'aggressive'
    if 'conservative' in bn:
        return 'conservative'
    return 'main'

def build_row(d, persona='main'):
    v = d.get('verification', {})
    dec = d.get('decision', {})
    mkt = d.get('market', {})
    sent = v.get('sentinel', {})
    rv = v.get('rv', {})
    replan = d.get('replan', {})
    cf = d.get('counterfactual', {})

    # Extract objections from RV
    objections = []
    for o in rv.get('objections', []):
        text = o.get('explanation', o.get('text', str(o)))
        if isinstance(text, str) and text.strip():
            objections.append(text.strip())

    # Sentinel reason as backup objection
    sentinel_reason = sent.get('reason', '')

    return {
        'ts': d.get('timestamp', ''),
        'cycle': d.get('cycle', 0),
        'persona': persona,
        'symbol': dec.get('symbol', mkt.get('symbol', '')),
        'side': dec.get('side', 'flat'),
        'leverage': dec.get('leverage', 0),
        'action': dec.get('action', ''),
        'thesis': dec.get('thesis', ''),
        'reasoning': dec.get('reasoning', ''),
        'verdict': v.get('finalVerdict', 'N/A'),
        'sentinelVerdict': sent.get('verdict', ''),
        'sentinelConf': sent.get('confidence', 0),
        'sentinelReason': sentinel_reason,
        'rvVerdict': rv.get('verdict', ''),
        'rvConf': rv.get('confidence', 0),
        'objections': objections,
        'replanAction': replan.get('action', ''),
        'replanThesis': replan.get('thesis', ''),
        'cfPnl': cf.get('pnl', None),
        'cfOutcome': cf.get('outcome', ''),
        'cfStatus': cf.get('status', ''),
        'claimHash': sent.get('attestation', {}).get('claimHash', ''),
        'evidenceHash': sent.get('attestation', {}).get('evidenceHash', ''),
        'price': mkt.get('price', 0),
    }

def aggregate_objections(rows):
    counter = Counter()
    examples = {}
    for r in rows:
        for o in r['objections']:
            key = o.lower()[:80].strip()
            counter[key] += 1
            if key not in examples:
                examples[key] = o[:200]
    return [{'pattern': examples[k], 'count': c} for k, c in counter.most_common(10)]

def generate_html(all_rows):
    total = len(all_rows)
    blocks = [r for r in all_rows if r['verdict'] in ('BLOCK', 'UNCERTAIN')]
    allows = [r for r in all_rows if r['verdict'] == 'ALLOW']
    flat = [r for r in all_rows if r['side'] == 'flat']

    top_objections = aggregate_objections(all_rows)

    rows_json = json.dumps(all_rows, ensure_ascii=False)

    # Stats
    from datetime import datetime
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verified Trading Agent — Decision Log</title>
<style>
:root{{--bg:#0b0e14;--bg2:#141925;--card:#1a1f2e;--tx:#e6e9ef;--tx2:#8a93a6;--grn:#3ecf8e;--red:#ff5b6e;--blu:#5b8cff;--org:#ffa726;--brd:#222a3a}}
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--tx);line-height:1.5}}
.wrap{{max-width:1200px;margin:0 auto;padding:24px 20px}}
.header{{border-bottom:1px solid var(--brd);padding-bottom:20px;margin-bottom:24px}}
.header h1{{font-size:1.8rem;margin-bottom:4px}}
.header .sub{{color:var(--tx2);font-size:.9rem;max-width:800px}}
.stats{{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}}
.stat{{background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:14px 16px;flex:1 1 130px;text-align:center}}
.stat .n{{font-size:1.5rem;font-weight:700}}.stat .l{{color:var(--tx2);font-size:.7rem;text-transform:uppercase;letter-spacing:.04em}}
.stat.harm .n{{color:var(--red)}}
.disclaimer{{background:var(--bg2);border:1px solid var(--brd);border-left:3px solid var(--blu);border-radius:8px;padding:12px 16px;color:var(--tx2);font-size:.8rem;margin-bottom:20px}}
/* Timeline */
.timeline-section{{background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:14px;margin-bottom:20px}}
.timeline-section h4{{margin-bottom:8px;font-size:.85rem;color:var(--tx2)}}
.legend{{display:flex;gap:12px;flex-wrap:wrap;font-size:.75rem;color:var(--tx2);margin-bottom:6px}}
.leg{{display:flex;align-items:center;gap:3px}}
.timeline{{display:flex;flex-wrap:wrap;gap:3px}}
.dot{{display:inline-block;width:8px;height:8px;border-radius:50%;cursor:default}}
/* Patterns */
.patterns{{background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:16px;margin-bottom:20px}}
.patterns h3{{margin-bottom:10px;font-size:.95rem}}
.pat-row{{display:flex;align-items:baseline;gap:10px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)}}.pat-row:last-child{{border:0}}
.pat-count{{background:rgba(255,91,110,.2);color:var(--red);padding:2px 7px;border-radius:10px;font-size:.7rem;font-weight:600;min-width:28px;text-align:center}}
.pat-text{{font-size:.78rem;color:var(--tx2)}}
/* Filters */
.filters{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}}
.filters label{{font-size:.75rem;color:var(--tx2)}}
.filters select,.filters input{{background:var(--bg2);border:1px solid var(--brd);color:var(--tx);padding:5px 8px;border-radius:6px;font-size:.75rem}}
.filters .count{{margin-left:auto;font-size:.75rem;color:var(--tx2)}}
/* Table */
.tbl-wrap{{overflow-x:auto;margin-bottom:20px}}
table{{width:100%;border-collapse:collapse;font-size:.78rem}}
thead th{{background:var(--bg2);color:var(--tx2);padding:8px 6px;text-align:left;position:sticky;top:0;white-space:nowrap}}
tbody tr{{border-bottom:1px solid var(--brd);cursor:pointer;transition:background .15s}}
tbody tr:hover{{background:rgba(255,255,255,.03)}}
tbody td{{padding:7px 6px;white-space:nowrap}}
.v-ALLOW{{color:var(--grn);font-weight:600}}.v-BLOCK{{color:var(--red);font-weight:600}}
.v-UNCERTAIN{{color:var(--org);font-weight:600}}.v-NA{{color:#444}}
.p-main{{color:var(--blu)}}.p-aggressive{{color:var(--red)}}.p-conservative{{color:var(--grn)}}
.side-long{{color:var(--grn)}}.side-short{{color:var(--red)}}.side-flat{{color:#555}}
/* Detail row */
.detail-row td{{padding:0!important;border:0!important}}
.detail-inner{{background:var(--bg2);padding:14px 18px;border-bottom:2px solid var(--brd)}}
.detail-inner h5{{margin:10px 0 5px;color:var(--tx2);font-size:.75rem;text-transform:uppercase;letter-spacing:.4px}}
.detail-inner p{{font-size:.82rem;line-height:1.5;color:var(--tx2);margin-bottom:6px}}
.obj-list{{background:rgba(255,91,110,.06);border-left:3px solid var(--red);padding:8px 12px;border-radius:0 6px 6px 0;margin:6px 0}}
.obj-list li{{margin-bottom:5px;font-size:.78rem;color:var(--tx2)}}
.replan-box{{background:rgba(62,207,142,.08);border-left:3px solid var(--grn);padding:8px 12px;border-radius:0 6px 6px 0;margin:6px 0}}
.sentinel-box{{background:rgba(91,140,255,.06);border-left:3px solid var(--blu);padding:8px 12px;border-radius:0 6px 6px 0;margin:6px 0}}
.att{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.65rem;color:#555;cursor:pointer;margin-top:8px}}
.att:hover{{color:var(--tx2)}}
footer{{text-align:center;padding:24px 0;border-top:1px solid var(--brd);margin-top:30px;color:var(--tx2);font-size:.8rem}}
footer a{{color:var(--blu);text-decoration:none}}
@media(max-width:768px){{.wrap{{padding:12px}}.stats{{flex-direction:column}}table{{font-size:.7rem}}}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <h1>Verified Trading Agent — Decision Log</h1>
    <p class="sub">Autonomous agent (Kimi K2.6) scans crypto markets and proposes leveraged trades. <b>ThoughtProof verifies the reasoning</b> before execution. Every decision — allowed, blocked, or uncertain — with structured objections and re-plan outcomes.</p>
  </div>

  <div class="stats">
    <div class="stat"><div class="n">{total}</div><div class="l">Decisions verified</div></div>
    <div class="stat"><div class="n">{len(blocks)}</div><div class="l">Blocked / Uncertain</div></div>
    <div class="stat"><div class="n">{len(allows)}</div><div class="l">Allowed</div></div>
    <div class="stat"><div class="n">{len(flat)}</div><div class="l">Stayed flat</div></div>
    <div class="stat"><div class="n">{len([r for r in all_rows if r['replanAction']])}</div><div class="l">Re-plans triggered</div></div>
  </div>

  <div class="disclaimer">
    <b>What this shows.</b> RV is a <b>reasoning-integrity check, not a trading-alpha model</b>. It blocks decisions when the <i>reasoning</i> is unsound — hallucinated indicators, invented levels, contradicted data. Whether the market then happens to move favorably is orthogonal to whether the reasoning was defensible. Counterfactuals are paper-trade simulations.
  </div>

  <div class="timeline-section">
    <h4>Verdict Timeline</h4>
    <div class="legend">
      <span class="leg"><span class="dot" style="background:var(--grn)"></span> Allow</span>
      <span class="leg"><span class="dot" style="background:var(--org)"></span> Uncertain</span>
      <span class="leg"><span class="dot" style="background:var(--red)"></span> Block</span>
      <span class="leg"><span class="dot" style="background:#555"></span> Flat</span>
    </div>
    <div class="timeline" id="timeline"></div>
  </div>

  {"" if not top_objections else '<div class="patterns"><h3>🔍 Top Objection Patterns</h3>' + "".join(f'<div class="pat-row"><span class="pat-count">{o["count"]}×</span><span class="pat-text">{html.escape(o["pattern"])}</span></div>' for o in top_objections) + '</div>'}

  <div class="filters">
    <label>Verdict</label>
    <select id="fV"><option value="">All</option><option value="ALLOW">Allow</option><option value="BLOCK">Block</option><option value="UNCERTAIN">Uncertain</option></select>
    <label>Persona</label>
    <select id="fP"><option value="">All</option><option value="main">Main</option><option value="aggressive">Aggressive</option><option value="conservative">Conservative</option></select>
    <label>Side</label>
    <select id="fS"><option value="">All</option><option value="long">Long</option><option value="short">Short</option><option value="flat">Flat</option></select>
    <label>Symbol</label>
    <input id="fSym" placeholder="e.g. BTC" style="width:70px">
    <span class="count" id="rc"></span>
  </div>

  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>Time</th><th>Who</th><th>#</th><th>Side</th><th>Symbol</th><th>Lev</th><th>Verdict</th><th>Sentinel</th><th>Price</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <footer>
    <b>Powered by ThoughtProof Reasoning Verification</b><br>
    SKALE Testnet · ERC-8183 Reputation · <a href="https://thoughtproof.ai" target="_blank">thoughtproof.ai</a><br>
    Updated {now}
  </footer>
</div>

<script>
const ROWS = {rows_json};
const tbody = document.getElementById('tbody');
const fV = document.getElementById('fV');
const fP = document.getElementById('fP');
const fS = document.getElementById('fS');
const fSym = document.getElementById('fSym');
const rc = document.getElementById('rc');
let expanded = null;

// Build timeline
(function() {{
  const tl = document.getElementById('timeline');
  const sorted = [...ROWS].sort((a,b) => new Date(a.ts) - new Date(b.ts));
  sorted.forEach(r => {{
    const colors = {{ALLOW:'var(--grn)',BLOCK:'var(--red)',UNCERTAIN:'var(--org)'}};
    const c = r.side === 'flat' ? '#555' : (colors[r.verdict] || '#333');
    const d = document.createElement('span');
    d.className = 'dot';
    d.style.background = c;
    d.title = '#' + r.cycle + ' ' + r.side + ' ' + r.symbol + ' → ' + r.verdict;
    tl.appendChild(d);
  }});
}})();

function fmtTime(ts) {{
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{{day:'2-digit',month:'short'}}) + ' ' + d.toLocaleTimeString('en-GB',{{hour:'2-digit',minute:'2-digit'}});
}}

function esc(s) {{ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }}

function render() {{
  const vf=fV.value, pf=fP.value, sf=fS.value, symf=fSym.value.toUpperCase();
  tbody.innerHTML='';
  let shown=0;
  ROWS.forEach((r,idx) => {{
    if (vf && r.verdict!==vf) return;
    if (pf && r.persona!==pf) return;
    if (sf && r.side!==sf) return;
    if (symf && !r.symbol.includes(symf)) return;
    shown++;
    const tr = document.createElement('tr');
    tr.dataset.idx = String(idx);
    const vc = 'v-'+(r.verdict||'NA');
    const pc = 'p-'+r.persona;
    const sc = 'side-'+r.side;
    tr.innerHTML = `
      <td>${{fmtTime(r.ts)}}</td>
      <td class="${{pc}}">${{r.persona==='main'?'Main':r.persona==='aggressive'?'Agg':'Con'}}</td>
      <td>${{r.cycle}}</td>
      <td class="${{sc}}">${{r.side.toUpperCase()}}</td>
      <td>${{r.symbol.replace('USDT','')}}</td>
      <td>${{r.leverage}}×</td>
      <td class="${{vc}}">${{r.verdict}}</td>
      <td>${{r.sentinelVerdict ? r.sentinelVerdict[0]+' '+(r.sentinelConf*100).toFixed(0)+'%' : '—'}}</td>
      <td>${{r.price ? '$'+Number(r.price).toLocaleString() : '—'}}</td>
    `;
    tbody.appendChild(tr);
    if (expanded===idx) showDetail(idx,tr);
  }});
  rc.textContent = shown + ' of ' + ROWS.length;
}}

tbody.addEventListener('click', function(e) {{
  const tr = e.target.closest('tr');
  if (!tr || tr.classList.contains('detail-row')) return;
  const idx = parseInt(tr.dataset.idx, 10);
  if (isNaN(idx)) return;
  toggleDetail(idx, tr);
}});

function toggleDetail(idx,tr) {{
  const ex = tr.nextElementSibling;
  if (ex && ex.classList.contains('detail-row')) {{ ex.remove(); expanded=null; return; }}
  document.querySelectorAll('.detail-row').forEach(el => el.remove());
  expanded=idx;
  showDetail(idx,tr);
}}

function showDetail(idx,tr) {{
  const r = ROWS[idx];
  const dr = document.createElement('tr');
  dr.className = 'detail-row';

  let objHTML = '';
  if (r.objections.length > 0) {{
    objHTML = '<div class="obj-list"><h5>🛑 Structured Objections ('+r.objections.length+')</h5><ul>' +
      r.objections.map(o => '<li>'+esc(o)+'</li>').join('') + '</ul></div>';
  }}

  let sentinelHTML = '';
  if (r.sentinelReason) {{
    sentinelHTML = '<div class="sentinel-box"><h5>🛡 Sentinel Triage</h5><p>Verdict: '+r.sentinelVerdict+
      ' (confidence: '+(r.sentinelConf*100).toFixed(0)+'%)</p><p style="font-family:monospace;font-size:.72rem">'+esc(r.sentinelReason)+'</p></div>';
  }}

  let replanHTML = '';
  if (r.replanAction) {{
    replanHTML = '<div class="replan-box"><h5>↻ Re-Plan Response</h5><p><strong>'+esc(r.replanAction)+'</strong></p>' +
      (r.replanThesis ? '<p style="font-style:italic">'+esc(r.replanThesis)+'</p>' : '') + '</div>';
  }}

  let attHTML = '';
  if (r.claimHash) {{
    attHTML = '<div class="att" onclick="navigator.clipboard.writeText(\\''+r.claimHash+'\\')">🔏 claim '+r.claimHash.slice(0,14)+'… · evidence '+(r.evidenceHash||'').slice(0,14)+'… (click to copy)</div>';
  }}

  dr.innerHTML = '<td colspan="9"><div class="detail-inner">' +
    '<h5>Action</h5><p><strong>'+esc(r.action)+'</strong> @ $'+Number(r.price).toLocaleString()+'</p>' +
    '<h5>Thesis</h5><p>'+esc(r.thesis)+'</p>' +
    objHTML + sentinelHTML + replanHTML + attHTML +
    '</div></td>';
  tr.after(dr);
}}

fV.onchange = fP.onchange = fS.onchange = fSym.oninput = () => {{ expanded=null; render(); }};
render();
</script>
</body>
</html>'''


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', nargs='*', default=None)
    parser.add_argument('--output', default=None)
    args = parser.parse_args()

    if args.input:
        input_files = args.input
    else:
        input_files = sorted(glob.glob(str(RUNS_DIR / 'decisions*.jsonl')))
        # Only take current (non-archive) files
        input_files = [f for f in input_files if 'pre-' not in f]

    if args.output:
        output_path = args.output
    else:
        output_path = str(RUNS_DIR / 'block-log.html')

    print('🚀 Building SKALE Decision Log v2...')
    all_rows = []
    for f in input_files:
        persona = classify_persona(f)
        decisions = load_decisions(f)
        rows = [build_row(d, persona) for d in decisions]
        all_rows.extend(rows)
        print(f'  {os.path.basename(f)}: {len(rows)} decisions ({persona})')

    # Sort by timestamp desc
    all_rows.sort(key=lambda r: r['ts'], reverse=True)
    print(f'  Total: {len(all_rows)} decisions')

    html_content = generate_html(all_rows)
    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    with open(output_path, 'w') as f:
        f.write(html_content)
    print(f'✅ {os.path.abspath(output_path)}')


if __name__ == '__main__':
    main()
