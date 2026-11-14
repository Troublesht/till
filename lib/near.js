// TILL shared NEAR client (near-api-js v6.5.1, testnet).
// One place for the API surface so clerk/server/deploy never drift.
const near = require("near-api-js");
const fs = require("fs");
const path = require("path");

const DEFAULT_RPC = "https://rpc.testnet.fastnear.com"; // rpc.testnet.near.org is being retired
function resolveRpc() {
  // resolve at CALL time (after loadEnv has populated process.env from .env)
  return process.env.NEAR_RPC || process.env.TILL_RPC_URL || DEFAULT_RPC;
}
const NETWORK = process.env.NEAR_NETWORK || "testnet";

function loadEnv(file = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function provider() {
  return new near.providers.JsonRpcProvider({ url: resolveRpc() });
}

// Writable account: signs with the given secret key.
function account(id, secretKey) {
  const kp = near.KeyPair.fromString(secretKey);
  const signer = new near.KeyPairSigner(kp);
  return new near.Account(id, provider(), signer);
}

// 1 NEAR = 10^24 yoctoNEAR
const Y = (s) => BigInt(near.utils.format.parseNearAmount(String(s)));
const fmt = (yocto) => near.utils.format.formatNearAmount(String(yocto));
const GAS_300 = 300_000_000_000_000n;

async function view(contractId, method, args = {}) {
  const res = await provider().callFunction(contractId, method, args);
  if (res == null) return null;
  if (typeof res === "string") {
    try { return JSON.parse(Buffer.from(res, "base64").toString()); }
    catch { return res; }
  }
  return res;
}

async function balance(id) {
  const a = await provider().viewAccount(id);
  return BigInt(a.amount);
}

// signAndSendTransaction with backoff on rate-limited (429) / flaky RPC responses.
async function sendTx(accountObj, receiverId, actions) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await accountObj.signAndSendTransaction({ receiverId, actions });
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || "");
      const retryable = msg.includes("429") || msg.includes("503") || /rate.?limit/i.test(msg) || msg.includes("fetch failed");
      if (!retryable || attempt === 6) throw e;
      const wait = 2500 * attempt;
      console.error(`  (rpc busy, retry ${attempt}/6 in ${wait}ms: ${msg.split("\n")[0].slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Humanize contract log strings that embed raw yocto amounts:
//  "37636000000000000000000 -> 36506920000000000000000 yocto" -> "0.0376 -> 0.0365 NEAR"
//  "paid 300000000000000000000000 yocto to vendorco"          -> "paid 0.3000 NEAR to vendorco"
function prettyDetail(s) {
  if (typeof s !== "string") return s;
  return s.replace(/(\d{16,})\s*(?:->\s*(\d{16,}))?\s*yocto/g, (_m, a, b) =>
    b ? `${fmt(a, 4)} -> ${fmt(b, 4)} NEAR` : `${fmt(a, 4)} NEAR`
  );
}

// view with backoff on rate-limited (429) / flaky RPC responses.
// FastNear's free tier 429s bursts; the server serializes calls + caches,
// this is the last line of defense.
async function viewRetry(contractId, method, args = {}, { attempts = 4, delay = 1200 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await view(contractId, method, args);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const retryable = msg.includes("429") || msg.includes("503") || /rate.?limit/i.test(msg) || msg.includes("fetch failed");
      if (!retryable || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delay * i));
    }
  }
  throw lastErr;
}

module.exports = { near, loadEnv, provider, account, view, viewRetry, balance, sendTx, Y, fmt, prettyDetail, GAS_300, resolveRpc, NETWORK };
