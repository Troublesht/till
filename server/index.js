// TILL server — tiny Node http server, zero framework deps.
// Serves the static web app + a JSON API the web app polls.
// The clerk runs separately (clerk/index.js) and does the on-chain acting.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnv, view, viewRetry, NETWORK, resolveRpc, near, sendTx } = require("../lib/near.js");

loadEnv();
const CONTRACT = process.env.TILL_CONTRACT || "shop2.tillshop.testnet"; // default: the live TILL shop
const PORT = Number(process.env.PORT || 8787);
const WEB = path.join(__dirname, "..", "web", "dist");
const { account, GAS_300, Y } = require("../lib/near.js");
const CUSTOMER_KEY = process.env.TILL_CUSTOMER_KEY || "";
const CUSTOMER = process.env.TILL_CUSTOMER || "tillcustomer.testnet";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2",
};

// ---- /api/state, single-flight + short TTL cache -------------------------
// The browser polls every 4s; without this each poll is a 4-way parallel RPC
// burst, which FastNear's free tier rate-limits (429). We serialize the four
// views with retry, cache for 3s, and coalesce concurrent requests.
let stateCache = null; // { at, data }
let stateInflight = null;

async function getState() {
  if (stateCache && Date.now() - stateCache.at < 3000) return stateCache.data;
  if (stateInflight) return stateInflight;
  stateInflight = (async () => {
    try {
      const products = await viewRetry(CONTRACT, "products_list");
      const stats = await viewRetry(CONTRACT, "stats");
      const decisions = await viewRetry(CONTRACT, "decisions", { last: 60 });
      const constraints = await viewRetry(CONTRACT, "constraints");
      const out = {
        products: (products || []).map(([id, p]) => ({ id, ...p })),
        // True P&L: cost of goods SOLD (Σ unit_cost × sold_total) vs revenue.
        // The remaining inventory COGS (goods still on the shelf) is an asset,
        // not an expense, so gross margin uses only the cost of what was sold.
        stats: stats ? (() => {
          let cogsSold = 0n;
          for (const [, p] of products || []) cogsSold += BigInt(p.cost) * BigInt(p.sold_total || 0);
          const rev = BigInt(stats[0]);
          const gross = rev > cogsSold ? rev - cogsSold : 0n;
          return {
            revenue: stats[0],
            cogs: cogsSold.toString(),
            inventoryCogs: stats[1],
            gross: gross.toString(),
            settled: stats[3],
            window: stats[4], windowSold: stats[5], surge: stats[6], decisions: stats[7],
          };
        })() : null,
        decisions: decisions || [],
        constraints: constraints ? {
          marginFloorBp: constraints[0], maxMoveBp: constraints[1], priceCap: constraints[2],
          procureCap: constraints[3], maxStock: constraints[4], clerkKey: constraints[5],
          demandWindow: constraints[6], surgeMultBp: constraints[7],
        } : null,
        contract: CONTRACT,
        at: Date.now(),
      };
      stateCache = { at: Date.now(), data: out };
      return out;
    } catch (e) {
      // Serve the last good state on transient RPC failures (FastNear 429s)
      // so the console degrades to a stale board instead of a red JSON box.
      if (stateCache) { console.error("[till] state refresh failed, serving stale:", String(e.message).slice(0, 100)); return stateCache.data; }
      throw e;
    } finally {
      stateInflight = null;
    }
  })();
  return stateInflight;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, contract: CONTRACT, network: NETWORK }));
    }
    if (url.pathname === "/api/state") {
      const out = await getState();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    if (url.pathname === "/api/buy" && req.method === "POST") {
      if (!CUSTOMER_KEY) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "customer key not configured on server" }));
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { id, qty = 1 } = JSON.parse(body || "{}");
          const n = Math.max(1, Math.min(5, Number(qty) || 1));
          const p = await view(CONTRACT, "product", { id });
          if (!p) throw new Error("no such product");
          if (p.stock < n) throw new Error("out of stock");
          const deposit = (BigInt(p.price) * BigInt(n)).toString();
          const customer = account(CUSTOMER, CUSTOMER_KEY);
          const receipt = await sendTx(customer, CONTRACT, [
            near.transactions.functionCall("buy", { id, qty: n }, GAS_300, BigInt(deposit)),
          ]);
          const txHash = receipt.transaction_hash || receipt.transaction?.hash;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            tx: txHash,
            explorer: `https://explorer.testnet.near.org/transactions/${txHash}`,
            product: id, qty: n, amount: deposit,
          }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e.message || e).split("\n")[0] }));
        }
      });
      return;
    }
    // static
    let file = path.join(WEB, url.pathname === "/" ? "index.html" : url.pathname);
    if (!fs.existsSync(file) || !file.startsWith(WEB)) {
      file = path.join(WEB, "index.html");
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e).split("\n")[0] }));
  }
});

if (!CONTRACT) console.error("[till] TILL_CONTRACT not set in .env");
server.listen(PORT, () =>
  console.log(`[till] web + api on http://localhost:${PORT} (contract ${CONTRACT} @ ${resolveRpc()})`)
);
