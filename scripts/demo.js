// TILL demo — drives the full autonomous loop end-to-end.
// 1) the "customer" (tillcustomer.testnet) buys a few items on-chain
// 2) one clerk tick runs: it reads the chain, reprices toward demand,
//    restocks low shelves, and settles the supplier — all on-chain
// 3) prints the resulting P&L and every on-chain tx for the record
//
// Run: node scripts/demo.js
const { near, loadEnv, account, view, provider, sendTx, GAS_300, Y, fmt, prettyDetail, resolveRpc } = require("../lib/near.js");

loadEnv();
const C = process.env.TILL_CONTRACT || "shop2.tillshop.testnet"; // default: the live TILL shop
const CUSTOMER = process.env.TILL_CUSTOMER || "tillcustomer.testnet";
const CUSTOMER_KEY = process.env.TILL_CUSTOMER_KEY;
const { decide, execute } = require("../clerk/index.js");

(async () => {
  // Mode: what keys do we hold? A judge who clones the repo has none, so the
  // demo degrades to read-only — it still shows the live on-chain business,
  // the clerk's decision log, and the clerk's scoped key (read from chain).
  // With keys in .env it drives the full loop.
  const clerkKeyFromEnv = process.env.TILL_CLERK_KEY || null;
  const canBuy = !!CUSTOMER_KEY;          // customer can buy on-chain
  const canTick = !!clerkKeyFromEnv;      // clerk can act on-chain
  let clerkKeyFromChain = null;           // for DISPLAY when we don't hold the key
  if (!clerkKeyFromEnv) {
    // small retry: FastNear can 429 a cold burst; one retry keeps the probe honest
    for (let i = 0; i < 3 && !clerkKeyFromChain; i++) {
      try {
        const ov0 = await view(C, "owner_view");
        const ov = typeof ov0 === "string" ? JSON.parse(ov0) : ov0;
        clerkKeyFromChain = (ov && (ov.clerk_key || ov.clerkKey || (Array.isArray(ov) && ov[1]))) || null;
      } catch { /* owner_view format varies / not initialized / rate-limited; retry */ }
      if (i < 2) await new Promise((rs) => setTimeout(rs, 1500));
    }
  }
  const observeOnly = !canBuy && !canTick;
  if (observeOnly) {
    console.log(`\n--- observe-only mode (no testnet keys in .env) ---`);
    console.log(`The shop is still running on-chain; this shows its live state. Set`);
    console.log(`TILL_CUSTOMER_KEY / TILL_CLERK_KEY in .env to drive it yourself.`);
  }

  const txs = [];
  let customer = null;
  let before = [];
  if (canBuy) {
    const owner = await view(C, "owner_view").catch(() => null);
    if (!owner) {
      console.error("contract not deployed/initialized yet — run scripts/deploy.js first");
      process.exit(1);
    }
    customer = account(CUSTOMER, CUSTOMER_KEY);
  }
  before = (await view(C, "products_list").catch(() => [])) || [];
  // snapshot prices BEFORE this run (used to price what the customer bought)
  const unitPrice = (id) => {
    const pair = before.find(([i]) => i === id); // products_list returns [id, Product] pairs
    return pair ? { price: BigInt(pair[1].price), cost: BigInt(pair[1].cost) } : { price: 0n, cost: 0n };
  };
  const runSold = {}; // units of each product sold THIS run, for true run P&L
  const products = before;
  console.log(`\n=== TILL demo @ ${new Date().toISOString()} ===`);
  if (products.length) {
    console.log(`shelf: ${products.map(([id, p]) => `${id}(${p.stock} @ ${fmt(p.price, 3)})`).join("  ")}`);
  } else {
    console.log(`no products visible on ${C} — is the contract deployed?`);
  }

  // ---- 1) customer buys (drives the demand window) ----
  const buys = [
    { id: "coffee", qty: 3 }, // 3 sold in-window = "hot" -> the clerk will RAISE its price
  ];
  if (!canBuy) {
    console.log(`  [observe] skipping on-chain buys (no customer key in .env)`);
  }
  for (const b of buys) {
    if (!canBuy) continue;
    const p = (await view(C, "product", { id: b.id }));
    if (!p) continue;
    const qty = Math.min(b.qty, p.stock);
    if (qty < 1) {
      console.log(`  [buy] ${b.id} out of stock — skipped`);
      continue;
    }
    const deposit = (BigInt(p.price) * BigInt(qty)).toString();
    const r = await sendTx(customer, C, [
      near.transactions.functionCall("buy", { id: b.id, qty }, GAS_300, BigInt(deposit)),
    ]);
    const txh = r.transaction_hash || r.transaction?.hash;
    txs.push({ what: `customer bought ${b.id} x${qty}`, hash: txh });
    runSold[b.id] = (runSold[b.id] || 0) + qty; // units sold THIS run, for run P&L
    console.log(`  [buy]  ${b.id} x${qty}  ${fmt(deposit, 4)} NEAR  tx: https://explorer.testnet.near.org/transactions/${txh}`);
    await new Promise((rs) => setTimeout(rs, 2000));
  }

  // ---- 2) one clerk tick ----
  console.log(`\n--- clerk tick ---`);
  if (!canTick) {
    console.log(`  [observe] clerk is running autonomously on-chain (see the decision log below);`);
    console.log(`  set TILL_CLERK_KEY in .env to execute ticks from this machine.`);
    if (clerkKeyFromChain) console.log(`  clerk key on chain: ${clerkKeyFromChain}`);
  } else {
    const clerk = require("../clerk/index.js").makeClient();
    const { actions, windowSold } = await decide(clerk);
    console.log(`  clerk sees window demand ${windowSold}; ${actions.length} action(s)`);
    for (const a of actions.slice(0, 4)) {
      try {
        const r = await execute(clerk, a);
        txs.push({ what: `clerk ${a.kind} ${a.id || a.to || ""}`, hash: r.transaction_hash || r.transaction?.hash });
        console.log(`  [act]  ${a.kind} ${a.id || a.to || ""} — ${a.reason}`);
        console.log(`         tx: https://explorer.testnet.near.org/transactions/${r.transaction_hash || r.transaction?.hash}`);
        await new Promise((rs) => setTimeout(rs, 2000));
      } catch (e) {
        console.log(`  [act]  ${a.kind} ${a.id} rejected by contract (policy guard): ${String(e.message).split("\n")[0]}`);
      }
    }
  }

  // ---- 3) resulting P&L ----
  const stats = await view(C, "stats").catch(() => null);
  if (!stats) {
    console.log(`\n--- P&L ---`);
    console.log(`  no stats on ${C} — is the contract deployed? (run scripts/deploy.js)`);
  } else {
    const decisions = await view(C, "decisions", { last: 8 }).catch(() => []);
    const cogsOwed = (BigInt(stats[1]) - BigInt(stats[3])).toString();
    // true P&L for THIS run only: revenue from the units bought now vs their cost
    let runRev = 0n, runCogs = 0n;
    for (const id of Object.keys(runSold)) {
      const u = unitPrice(id);
      runRev += u.price * BigInt(runSold[id]);
      runCogs += u.cost * BigInt(runSold[id]);
    }
    const runGross = runRev > runCogs ? runRev - runCogs : 0n;
    console.log(`\n--- P&L after demo ---`);
    console.log(`  revenue:       ${fmt(stats[0], 4)} NEAR (lifetime)`);
    console.log(`  COGS (inventory): ${fmt(stats[1], 4)} NEAR (lifetime, goods on shelf + sold)`);
    console.log(`  settled to supplier: ${fmt(stats[3], 4)} NEAR (on-chain)`);
    console.log(`  COGS still owed:  ${fmt(cogsOwed, 4)} NEAR`);
    console.log(`  this run:        ${fmt(runRev, 4)} NEAR in - ${fmt(runCogs, 4)} NEAR COGS = ${fmt(runGross, 4)} NEAR gross margin`);
    console.log(`  latest on-chain decisions:`);
    for (const d of [...decisions].reverse())
      console.log(`    #${d.seq} ${d.kind.padEnd(16)} ${d.product || "-".padEnd(16)} ${prettyDetail(d.detail)}`);
  }

  console.log(`\n--- security check: the clerk key must be impotent outside its 3 methods ---`);
  const shopId = C;
  if (!canTick) {
    // No clerk secret key to try with — show the on-chain key instead, so the
    // judge sees the scoping for themselves.
    try {
      // raw JSON-RPC (avoids the SDK's query() param validation)
      const rpc = resolveRpc();
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "1", method: "query",
          params: {
            request_type: "view_access_key",
            account_id: shopId,
            public_key: clerkKeyFromChain,
            finality: "optimistic",
          },
        }),
      }).then((r) => r.json());
      const perm = res && res.result && res.result.permission;
      if (!perm || !perm.FunctionCall) throw new Error((res.error && res.error.message) || "not a FunctionCall key");
      const fc = perm.FunctionCall;
      console.log(`  clerk function-call key on chain (inspectable by anyone):`);
      console.log(`    receiver  : ${fc.receiver_id}`);
      const allowance = Number(BigInt(fc.allowance) / 10n ** 24n);
      console.log(`    allowance : ${allowance} NEAR (gas budget only — the 3 methods take no deposit, so it can never be spent)`);
      console.log(`    methods   : ${fc.method_names.join(", ")}`);
      console.log(`  a plain NEAR transfer signed with this key is rejected by the chain (function_call access key).`);
    } catch (e) {
      console.log(`  (could not fetch on-chain key: ${String(e.message).split("\n")[0]})`);
    }
  } else {
    const clerkRaw = require("../clerk/index.js").makeClient();
    try {
      await clerkRaw.sendMoney(shopId, Y("0.01").toString());
      console.log("  UNEXPECTED: clerk transfer SUCCEEDED — scoped key is broken!");
    } catch (e) {
      const m = String(e.message).split("\n")[0];
      console.log(`  clerk tried a plain NEAR transfer with its scoped key -> BLOCKED: ${m.slice(0, 110)}`);
    }
  }

  console.log(`\n${txs.length} on-chain transactions were produced by this demo run.`);
})().catch((e) => {
  console.error("DEMO FAILED:", e.message || e);
  process.exit(1);
});
