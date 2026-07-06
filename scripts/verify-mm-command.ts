// Quick verification of the testnet command mapping (no API, no mm login).
// Run: MM_PERPS_NETWORK=testnet npx tsx scripts/verify-mm-command.ts
import { buildMmCommand } from "../src/metamask-executor.js";

const decision = { side: "long", leverage: 2 } as any;
const market = { symbol: "SOLUSDT", price: 80.72 } as any;

const open = buildMmCommand(decision, market, "open");
const quote = buildMmCommand(decision, market, "quote");
const flat = buildMmCommand({ side: "flat", leverage: 0 } as any, market, "open");

console.log("OPEN :", open?.pretty);
console.log("QUOTE:", quote?.pretty);
console.log("FLAT :", flat === null ? "null (correct — no command for flat)" : flat);

// Assertions
const args = open!.args;
const size = args[args.indexOf("--size") + 1];
const net = args[args.indexOf("--network") + 1];
// 100 USD budget * 2x lev / 80.72 price = 2.4777 SOL
const expectedSize = Math.round((100 * 2 / 80.72) * 1e4) / 1e4;
console.log("");
console.log(`size = ${size} (expected ~${expectedSize} SOL, base asset not USD)`, Number(size) === expectedSize ? "✅" : "❌");
console.log(`network = ${net}`, net === "testnet" ? "✅" : "❌");
console.log(`has --leverage 2`, args[args.indexOf("--leverage") + 1] === "2" ? "✅" : "❌");
console.log(`symbol normalised SOLUSDT→SOL`, args[args.indexOf("--symbol") + 1] === "SOL" ? "✅" : "❌");
