// PM2 process configuration for the verified trading agent.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 logs verified-trading-agent
//   pm2 stop verified-trading-agent
//   pm2 restart verified-trading-agent
//
// The agent runs the continuous loop (src/main.ts, no --once), reasoning +
// verifying one decision every CYCLE_INTERVAL_SEC (set to 7200 = 2h in .env).
// PM2 keeps it alive across crashes and (with `pm2 startup`) machine reboots.

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
  ],
};
