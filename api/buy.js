// TILL — "buy on-chain" as a Vercel serverless function (serverless demo wallet).
// Self-contained on purpose: Vercel function bundlers cannot require() files
// that live outside the function's project root, so the small near-client
// surface we need (provider / account / sign+send with backoff / view) is
// inlined here instead of imported from ../../lib/near.js.
//
// Security note: this demo wallet is a TESTNET key (TILL_CUSTOMER_KEY), the
// same one server/index.js uses locally. It is set as a Vercel env var, never
// committed, and never shipped to the browser — only this server-side function
// ever sees it.
const near = require("near-api-js");

const RPC = process.env.NEAR_RPC || process.env.TILL_RPC_URL || "https://rpc.testnet.fastnear.com";
const CONTRACT = process.env.TILL_CONTRACT || "shop2.tillshop.testnet";
const CUSTOMER = process.env.TILL_CUSTOMER || "tillcustomer.testnet";
const GAS_300 = 300_000_000_000_000n; // 300 TGas — enough for buy() incl. the COGS settlement

const provider = () => new near.providers.JsonRpcProvider({ url: RPC });

function account(id, secretKey) {
  const kp = near.KeyPair.fromString(secretKey);
  const signer = new near.KeyPairSigner(kp);
  return new near.Account(id, provider(), signer);
}

// signAndSendTransaction with backoff on 429 / flaky testnet RPC responses.
// Same call shape as lib/near.js (near-api-js v6.5.1): it fetches the latest
// block internally.
async function sendTx(accountObj, receiverId, actions) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await accountObj.signAndSendTransaction({ receiverId, actions });
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const retryable = msg.includes("429") || msg.includes("503") || /rate.?limit/i.test(msg) || msg.includes("fetch failed");
      if (!retryable || attempt === 6) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

async function view(method, args = {}) {
  const res = await provider().callFunction(CONTRACT, method, args);
  if (res == null) return null;
  if (typeof res === "string") {
    try { return JSON.parse(Buffer.from(res, "base64").toString()); }
    catch { return res; }
  }
  return res;
}

exports.config = {
  maxDuration: 60, // 6 backoff retries on RPC 429s can take ~25s
};

exports.default = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const { id, qty = 1 } = req.body || {};
    if (!id || typeof id !== "string" || !/^[a-z0-9_]{1,32}$/.test(id)) {
      res.status(400).json({ error: "bad product id" });
      return;
    }
    const key = process.env.TILL_CUSTOMER_KEY || process.env.TILL_CUSTOMER_SECRET_KEY;
    if (!key) {
      res.status(503).json({ error: "customer key not configured (set TILL_CUSTOMER_KEY in Vercel env)" });
      return;
    }
    const n = Math.max(1, Math.min(5, Number(qty) || 1));
    const p = await view("product", { id });
    if (!p) { res.status(400).json({ error: "no such product" }); return; }
    if (p.stock < n) { res.status(400).json({ error: "out of stock" }); return; }
    const deposit = (BigInt(p.price) * BigInt(n)).toString();
    const customer = account(CUSTOMER, key);
    const receipt = await sendTx(customer, CONTRACT, [
      near.transactions.functionCall("buy", { id, qty: n }, GAS_300, BigInt(deposit)),
    ]);
    const txHash = receipt.transaction_hash || receipt.transaction?.hash;
    res.status(200).json({
      ok: true,
      tx: txHash,
      explorer: `https://explorer.testnet.near.org/transactions/${txHash}`,
      product: id,
      qty: n,
      amount: deposit,
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e).split("\n")[0] });
  }
};
