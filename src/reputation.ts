// ERC-8004 Reputation module — writes verification verdicts on-chain.
//
// After each decision cycle, the verdict (ALLOW/BLOCK/UNCERTAIN) is written
// to the ERC-8004 Reputation Registry on SKALE testnet as a feedback signal.
// This turns ephemeral verification results into durable, evidence-based
// on-chain reputation — the missing "was the decision correct?" layer
// that pure staking reputation (ARP/Intuition) can't provide.
//
// Chain: SKALE Base Sepolia Testnet (zero-gas, so writes are free).
// Registry ABIs and addresses sourced from @thoughtproof/skale-agent,
// inlined here to keep the demo repo self-contained.

import { ethers } from "ethers";
import { createHash } from "node:crypto";
import type { DecisionRecord, VerificationResult, Verdict } from "./types.js";

// ─── SKALE Testnet Chain Config ───────────────────────────────────────────────

const SKALE_BASE_SEPOLIA = {
  chainId: 324705682,
  name: "SKALE Base Sepolia",
  rpcUrl:
    "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
  explorer: "https://base-sepolia-testnet-explorer.skalenodes.com/",
} as const;

// ERC-8004 Registry Addresses (testnet — canonical cross-chain addresses)
const REGISTRIES = {
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const,
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const,
} as const;

// ─── ABIs (from @thoughtproof/skale-agent, minimal subset) ────────────────────

const IDENTITY_REGISTRY_ABI = [
  "function register(string agentURI) external returns (uint256)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];

const REPUTATION_REGISTRY_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external",
  "function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
];

// ─── Verdict → Feedback Encoding ──────────────────────────────────────────────

/**
 * Encode a verdict as a signed int128 reputation score.
 *   ALLOW  → +100 (2 decimals → 1.00)
 *   BLOCK  → -100 (2 decimals → -1.00)
 *   UNCERTAIN → 0 (2 decimals → 0.00)
 *
 * The value semantics: positive = good reasoning (allowed), negative = bad
 * reasoning (blocked). Magnitude is 1.0 (full conviction). UNCERTAIN is zero
 * because the verifier couldn't decide — it's absence of evidence, not evidence
 * of absence. All at 2 decimal places for clean readability.
 */
function verdictToScore(verdict: Verdict): { value: bigint; decimals: number } {
  switch (verdict) {
    case "ALLOW":
      return { value: 100n, decimals: 2 };
    case "BLOCK":
      return { value: -100n, decimals: 2 };
    case "UNCERTAIN":
      return { value: 0n, decimals: 2 };
  }
}

/**
 * Build tags for the feedback entry.
 *   tag1: verdict route ("sentinel" | "rv" | "pipeline")
 *   tag2: verdict itself ("ALLOW" | "BLOCK" | "UNCERTAIN")
 * These are indexed on-chain (tag1 is indexed in the event) for queryability.
 */
function buildTags(verification: VerificationResult): {
  tag1: string;
  tag2: string;
} {
  return {
    tag1: verification.route,
    tag2: verification.finalVerdict,
  };
}

/**
 * Build a feedbackURI pointing to the decision context.
 * For now, this is a data URI with the minimal record summary.
 * In Phase 2 this could be an IPFS/Arweave link to the full JSONL entry.
 */
function buildFeedbackURI(record: DecisionRecord): string {
  const summary = {
    cycle: record.cycle,
    symbol: record.market.symbol,
    action: record.decision.action,
    thesis: record.decision.thesis,
    verdict: record.verification.finalVerdict,
    route: record.verification.route,
    outcome: record.outcome,
    attestation: record.verification.sentinel?.attestation ?? null,
    timestamp: record.timestamp,
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(summary)).toString("base64")}`;
}

/**
 * Compute a feedback hash (SHA-256) of the decision record.
 * This anchors the on-chain entry to the specific off-chain evidence. Anyone can
 * verify: hash(record) === on-chain feedbackHash.
 *
 * STABILITY NOTE: Only deterministic, decision-time fields are included.
 * Do NOT add enrichments (Polymarket data changes with cache TTL),
 * market snapshots (price drift), or any post-hoc computed field.
 * The hash must be reproducible from the JSONL record alone.
 */
function computeFeedbackHash(record: DecisionRecord): string {
  const canonical = JSON.stringify({
    cycle: record.cycle,
    timestamp: record.timestamp,
    action: record.decision.action,
    reasoning: record.decision.reasoning,
    verdict: record.verification.finalVerdict,
    route: record.verification.route,
    sentinelAttestation: record.verification.sentinel?.attestation ?? null,
  });
  return "0x" + createHash("sha256").update(canonical).digest("hex");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ReputationConfig {
  /** Private key for signing transactions (hex, with 0x prefix) */
  privateKey: string;
  /** ERC-8004 Agent ID (token ID) to write feedback for */
  agentId: bigint;
}

export class ReputationWriter {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private readonly reputationRegistry: ethers.Contract;
  private readonly identityRegistry: ethers.Contract;
  readonly agentId: bigint;

  constructor(config: ReputationConfig) {
    this.provider = new ethers.JsonRpcProvider(SKALE_BASE_SEPOLIA.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.agentId = config.agentId;

    this.reputationRegistry = new ethers.Contract(
      REGISTRIES.reputation,
      REPUTATION_REGISTRY_ABI,
      this.wallet,
    );

    this.identityRegistry = new ethers.Contract(
      REGISTRIES.identity,
      IDENTITY_REGISTRY_ABI,
      this.wallet,
    );
  }

  /**
   * Write a decision's verdict on-chain as ERC-8004 feedback.
   * Returns the transaction hash, or null if writing was skipped (e.g. flat/no-trade).
   */
  async writeFeedback(record: DecisionRecord): Promise<string | null> {
    // Skip no-trade cycles — they produce no verdict worth anchoring.
    if (record.noTrade) {
      return null;
    }

    const { value, decimals } = verdictToScore(
      record.verification.finalVerdict,
    );
    const { tag1, tag2 } = buildTags(record.verification);
    const feedbackURI = buildFeedbackURI(record);
    const feedbackHash = computeFeedbackHash(record);

    const endpoint = `sentinel.thoughtproof.ai${record.verification.route === "pipeline" ? "+api.thoughtproof.ai" : ""}`;

    const tx = await this.reputationRegistry.giveFeedback(
      this.agentId,
      value,
      decimals,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash,
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }

  /**
   * Register a new agent and return the agentId.
   * Used once during setup; the agentId goes into .env for all subsequent runs.
   */
  async registerAgent(metadataUri: string): Promise<{
    agentId: bigint;
    txHash: string;
  }> {
    const tx = await this.identityRegistry.register(metadataUri);
    const receipt = await tx.wait();

    const event = receipt.logs.find((log: any) => {
      try {
        return (
          this.identityRegistry.interface.parseLog(log)?.name === "Registered"
        );
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error(
        "Registered event not found in transaction receipt",
      );
    }

    const parsed = this.identityRegistry.interface.parseLog(event);
    if (!parsed) {
      throw new Error("Failed to parse Registered event");
    }
    return { agentId: parsed.args.agentId, txHash: receipt.hash };
  }

  /**
   * Check if the agent exists (by querying ownerOf).
   */
  async verifyAgent(): Promise<{ exists: boolean; owner?: string }> {
    try {
      const owner = (await this.identityRegistry.ownerOf(
        this.agentId,
      )) as string;
      return { exists: true, owner };
    } catch {
      return { exists: false };
    }
  }

  get address(): string {
    return this.wallet.address;
  }

  get explorerUrl(): string {
    return `${SKALE_BASE_SEPOLIA.explorer}address/${REGISTRIES.reputation}`;
  }
}

// ─── Exports for use outside class ────────────────────────────────────────────

export { SKALE_BASE_SEPOLIA, REGISTRIES, computeFeedbackHash };
