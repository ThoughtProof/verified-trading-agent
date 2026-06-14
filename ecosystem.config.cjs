// PM2 process configuration for the verified trading agent.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs verified-trading-agent
//   pm2 stop verified-trading-agent
//   pm2 restart verified-trading-agent
//
// The agent runs the continuous loop (src/main.ts, no --once), reasoning +
// verifying one decision every CYCLE_INTERVAL_SEC (set in .env: 1200=20min
// until Fri demo, then 3600=1h). PM2 keeps it alive across crashes and (with
// `pm2 startup`) machine reboots.
//
// A second app, blocklog-watcher, rebuilds the HTML block-log whenever the
// agent appends a decision. Zero cost (local JSONL read + free Binance API).

module.exports = {
  apps: [
    {
      name: "verified-trading-agent",
      // Run via tsx (the repo's TS runner). No build step needed.
      script: "./node_modules/.bin/tsx",
      args: "src/main.ts",
      cwd: __dirname,
      // Loop mode runs forever; we do NOT want pm2 to treat a long-running
      // process as a crash. interpreter "none" because script IS the executable.
      interpreter: "none",
      // Restart policy: if the process exits (crash, network death), restart it,
      // but back off so we don't hammer APIs in a tight crash loop.
      autorestart: true,
      restart_delay: 30_000, // 30s between restarts
      max_restarts: 50, // give up after 50 rapid restarts (something is wrong)
      min_uptime: 60_000, // must stay up 60s to count as a "good" start
      // Memory guard — restart if it somehow leaks past 300MB.
      max_memory_restart: "300M",
      // Logs (timestamped) — pm2 captures stdout/stderr to these files.
      time: true,
      out_file: "./runs/pm2-out.log",
      error_file: "./runs/pm2-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "blocklog-watcher",
      script: "./node_modules/.bin/tsx",
      args: "scripts/watch-blocklog.ts",
      cwd: __dirname,
      interpreter: "none",
      autorestart: true,
      restart_delay: 10_000,
      max_restarts: 50,
      min_uptime: 30_000,
      max_memory_restart: "200M",
      time: true,
      out_file: "./runs/pm2-watcher-out.log",
      error_file: "./runs/pm2-watcher-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      // Aggressive persona — a SECOND, fully isolated paper line. Same engine,
      // same verification pipeline, but PERSONA=aggressive (leveraged momentum
      // seeker) writing to its OWN decisions log so it never contaminates the
      // disciplined line's record. Onchain reputation writes are OFF here
      // (no AGENT_ID/PRIVATE_KEY) — this is measurement-only paper until we
      // decide to promote it with a dedicated ERC-8004 identity.
      name: "vta-aggressive",
      script: "./node_modules/.bin/tsx",
      args: "src/main.ts",
      cwd: __dirname,
      interpreter: "none",
      autorestart: true,
      restart_delay: 30_000,
      max_restarts: 50,
      min_uptime: 60_000,
      max_memory_restart: "300M",
      time: true,
      out_file: "./runs/pm2-aggressive-out.log",
      error_file: "./runs/pm2-aggressive-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PERSONA: "aggressive",
        DECISIONS_LOG: "decisions-aggressive.jsonl",
        // Explicitly blank the onchain identity so reputation writes stay OFF
        // and never touch the disciplined line's agent #571.
        AGENT_ID: "",
        PRIVATE_KEY: "",
        REPUTATION_PRIVATE_KEY: "",
      },
    },
    {
      // Conservative persona — a THIRD isolated paper line. Capital-preservation
      // trader that takes only high-confluence, small (≤1-2x), hard-stopped
      // positions. Its whole purpose is to produce the ALLOW half of the
      // block-log: genuinely well-reasoned low-stake trades that RV can pass.
      // We did NOT lower any threshold for it — the stake ladder now maps a 1x
      // defined-risk trade to "low" (0.40) by real position risk, and sound
      // reasoning earns a stable ALLOW. Isolated log + onchain OFF, same as
      // aggressive, so it never touches the disciplined line's agent #571.
      name: "vta-conservative",
      script: "./node_modules/.bin/tsx",
      args: "src/main.ts",
      cwd: __dirname,
      interpreter: "none",
      autorestart: true,
      restart_delay: 30_000,
      max_restarts: 50,
      min_uptime: 60_000,
      max_memory_restart: "300M",
      time: true,
      out_file: "./runs/pm2-conservative-out.log",
      error_file: "./runs/pm2-conservative-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PERSONA: "conservative",
        DECISIONS_LOG: "decisions-conservative.jsonl",
        AGENT_ID: "",
        PRIVATE_KEY: "",
        REPUTATION_PRIVATE_KEY: "",
      },
    },
  ],
};
