#!/usr/bin/env tsx
// Register a new ERC-8004 agent on SKALE testnet.
// Run once, then put the returned agentId into .env as AGENT_ID.
//
// Usage: npx tsx scripts/register-agent.ts

import "dotenv/config";
import { ReputationWriter } from "../src/reputation.js";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY in .env first.");
  process.exit(1);
}

const metadata = {
  name: "ThoughtProof Verified Trading Agent",
  description:
    "Autonomous crypto trading agent verified by ThoughtProof. Every decision passes through Sentinel (pre-execution gate) and RV (adversarial critique) before acting. Demonstrates avoided harm, not returns.",
  capabilities: [
    "trading",
    "verification-consumer",
    "sentinel-gated",
    "rv-adversarial",
  ],
  version: "0.1.0",
  owner: "ThoughtProof",
  model: "kimi-k2.6",
  verifierPanel: ["grok", "deepseek", "gemini", "sonnet"],
};

const metadataUri = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString("base64")}`;

// Use a dummy agentId for registration (it returns the real one)
const writer = new ReputationWriter({
  privateKey: PRIVATE_KEY,
  agentId: 0n,
});

console.log(`Registering agent from wallet ${writer.address}...`);
console.log(`Chain: SKALE Base Sepolia Testnet (zero-gas)`);

const { agentId, txHash } = await writer.registerAgent(metadataUri);

console.log(`\n✅ Agent registered!`);
console.log(`   Agent ID: ${agentId}`);
console.log(`   TX Hash:  ${txHash}`);
console.log(`\nAdd to .env:`);
console.log(`   AGENT_ID=${agentId}`);
