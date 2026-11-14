import { useEffect, useRef, useState } from "react";

// 1 NEAR = 10^24 yoctoNEAR. Keep 6 decimal places of precision:
// divide by 10^18 as a BigInt (micro-integer), then scale by 1e6.
const fmt = (yocto, dp = 4) => {
  if (yocto == null) return "0";
  const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
  return n.toFixed(dp).replace(/\.?0+$/, "") || "0";
};

/* ---------------- direct testnet RPC (static-hosting fallback) ----------- */
// When this folder is hosted statically (e.g. Vercel) there is no same-origin
// /api/state. FastNear serves NEAR testnet with `Access-Control-Allow-Origin: *`
// (verified 2026-11-14), so the browser can read the shop straight from chain.
const DIRECT_RPC = "https://rpc.testnet.fastnear.com";
const DIRECT_CONTRACT = "shop2.tillshop.testnet";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcView(method, args = {}) {
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(DIRECT_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "call_function",
          params: { account_id: DIRECT_CONTRACT, method_name: method, arguments: args },
        }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.name || "RPC error");
      const b64 = j.result && j.result.result && j.result.result[0];
      if (b64 == null) return null;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const txt = new TextDecoder("utf-8").decode(bytes);
      try { return JSON.parse(txt); } catch { return txt; }
    } catch (e) {
      lastErr = e;
      const retryable = /429|503|rate|Failed to fetch/i.test(String(e.message || e));
      if (!retryable || i === 4) throw e;
      await sleep(1200 * i);
    }
  }
  throw lastErr;
}

// Same shape as /api/state (server/index.js), built from 4 on-chain views.
// Calls are SEQUENTIAL on purpose: FastNear's free tier 429s parallel bursts.
async function stateDirect() {
  const products = await rpcView("products_list");
  const stats = await rpcView("stats");
  const decisions = await rpcView("decisions", { last: 60 });
  const constraints = await rpcView("constraints");
  return {
    products: (products || []).map(([id, p]) => ({ id, ...p })),
    stats: stats ? (() => {
      let cogsSold = 0n;
      for (const [, p] of products || []) cogsSold += BigInt(p.cost) * BigInt(p.sold_total || 0);
      const rev = BigInt(stats[0]);
      const gross = rev > cogsSold ? rev - cogsSold : 0n;
      return {
        revenue: stats[0], cogs: cogsSold.toString(), inventoryCogs: stats[1],
        gross: gross.toString(), settled: stats[3], window: stats[4],
        windowSold: stats[5], surge: stats[6], decisions: stats[7],
      };
    })() : null,
    decisions: decisions || [],
    constraints: constraints ? {
      marginFloorBp: constraints[0], maxMoveBp: constraints[1], priceCap: constraints[2],
      procureCap: constraints[3], maxStock: constraints[4], clerkKey: constraints[5],
      demandWindow: constraints[6], surgeMultBp: constraints[7],
    } : null,
    contract: DIRECT_CONTRACT,
    at: Date.now(),
    direct: true,
  };
}

export function useTill() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(false);
  const prev = useRef(null);
  const directMode = useRef(null); // null=unknown, true=use direct RPC

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        let j = null;
        if (directMode.current !== true) {
          // Prefer the same-origin API (node server); on static hosts it 404s
          // or isn't JSON, so we latch to direct on-chain mode once.
          try {
            const r = await fetch("/api/state");
            if (r.ok) {
              const t = r.headers.get("content-type") || "";
              if (t.includes("json")) j = await r.json();
            }
          } catch {}
          if (!j) {
            if (directMode.current === false) setError("no /api/state and direct RPC failed");
            directMode.current = true;
          }
        }
        if (j == null) j = await stateDirect();
        if (!live) return;
        if (j.error) throw new Error(j.error);
        const changed =
          prev.current &&
          (j.stats?.decisions !== prev.current.stats?.decisions ||
            JSON.stringify(j.products) !== JSON.stringify(prev.current.products));
        prev.current = j;
        setState(j);
        setError(null);
        if (changed) {
          setFlash(true);
          setTimeout(() => setFlash(false), 1200);
        }
      } catch (e) {
        if (live) setError(e.message);
      }
    };
    load();
    const t = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  return { state, error, flash, fmt };
}

export async function buyOnChain(id, qty) {
  const r = await fetch("/api/buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, qty }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "purchase failed");
  return j;
}
