#!/usr/bin/env python3
"""Watchdog for the verified-trading-agent pm2 process.

Checks:
  1. Is the pm2 process 'verified-trading-agent' online?
  2. Has it restarted abnormally often (crash loop)?
  3. Is the decisions.jsonl log still growing (cycles actually completing)?

Prints a SHORT status line. Stays SILENT (empty output) when everything is
healthy and a cycle has completed recently — so a no_agent cron job only
messages you when something needs attention.

Exit code is always 0; the message (or silence) is the signal.
"""

import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/Users/rauljager/PROJECTS/ThoughtProof/verified-trading-agent")
LOG = REPO / "runs" / "decisions.jsonl"
PROC = "verified-trading-agent"
# 2h cycle interval; allow generous slack (a high-stakes RV cycle + retries).
# If no new decision in 5h, something is stuck.
STALE_HOURS = 5


def pm2_status():
    """Return (status, restarts) for the process, or (None, None) if absent."""
    try:
        out = subprocess.run(
            ["pm2", "jlist"], capture_output=True, text=True, timeout=30
        ).stdout
        procs = json.loads(out)
    except Exception as e:
        return ("pm2_error:" + str(e)[:80], None)
    for p in procs:
        if p.get("name") == PROC:
            env = p.get("pm2_env", {})
            return (env.get("status"), env.get("restart_time", 0))
    return (None, None)


def last_decision_age_hours():
    """Hours since the last decision was logged, or None if no log / empty."""
    if not LOG.exists():
        return None
    last_line = None
    with open(LOG, "rb") as f:
        for line in f:
            if line.strip():
                last_line = line
    if not last_line:
        return None
    try:
        rec = json.loads(last_line)
        ts = datetime.fromisoformat(rec["timestamp"].replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - ts
        return delta.total_seconds() / 3600.0
    except Exception:
        return None


def main():
    alerts = []

    status, restarts = pm2_status()
    if status is None:
        alerts.append(f"🔴 Process '{PROC}' NOT FOUND in pm2 (stopped or deleted).")
    elif status != "online":
        alerts.append(f"🔴 Process '{PROC}' status='{status}' (not online). Restarts={restarts}.")
    elif restarts and restarts > 20:
        alerts.append(f"⚠️ Process online but {restarts} restarts — possible crash loop.")

    # Only check log staleness if the process is supposedly online.
    if status == "online":
        age = last_decision_age_hours()
        if age is None:
            # No decisions logged yet — only alarming if it's been up a while.
            # First flat cycle does NOT write to the log (no verdict), so a fresh
            # start with only flat cycles can legitimately have no new entries.
            pass
        elif age > STALE_HOURS:
            alerts.append(
                f"⚠️ Last logged decision was {age:.1f}h ago (>{STALE_HOURS}h). "
                f"Agent may be stuck, or only producing flat cycles (which aren't logged)."
            )

    if alerts:
        header = f"🤖 Verified Trading Agent watchdog — {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        print(header)
        for a in alerts:
            print(a)
    # else: silent — healthy, no message.


if __name__ == "__main__":
    main()
