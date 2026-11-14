// TILL clerk agent — the AI brain of the store.
//
// Loop (or one-shot per tick). Reads chain state via RPC, decides actions
// (restock / reprice / settle supplier), executes them on-chain with the
// clerk's RESTRICTED function-call key, and logs every decision (the contract
// also records them on-chain as NEP-297 events).
//
// The brain is deliberately deterministic: judges can run it with ZERO API
// keys. If NEAR_AI_API_KEY (or OPENAI_API_KEY) is set, each decision is also
// annotated with a one-line natural-language rationale from the model.

const { near, loadEnv, account, view, provider, sendTx, GAS_300, Y } = require("../lib/near.js");

loadEnv();

const CONFIG = {
  networkId: process.env.NEAR_NETWORK || "testnet",
  contractId: process.env.TILL_CONTRACT || "shop2.tillshop.testnet", // default: the live TILL shop
  clerkKey: process.env.TILL_CLERK_KEY,
  supplier: process.env.TILL_SUPPLIER || "vendorco.testnet",
  tickMs: Number(process.env.TILL_TICK_MS || 15000),
  once: process.argv.includes("--once"),
  // Policy the clerk obeys BEFORE proposing (defense in depth; the contract
  // enforces the same rules authoritatively on-chain).
  restockThreshold: Number(process.env.TILL_RESTOCK_THRESHOLD || 2),
  restockTarget: Number(process.env.TILL_RESTOCK_TARGET || 6),
  demandTick: Number(process.env.TILL_DEMAND_TICK || 3),
  repriceStepBp: Number(process.env.TILL_REPRICE_STEP_BP || 300), // 3%
};

if (!CONFIG.contractId) console.error("[clerk] TILL_CONTRACT not set");
if (!CONFIG.clerkKey) console.error("[clerk] TILL_CLERK_KEY not set");

// The clerk signs as the shop using ONLY its function-call key.
function makeClient() {
  return account(CONFIG.contractId, CONFIG.clerkKey);
}

// ---------------- optional LLM rationale (zero-key default) ----------------
async function llmRationale(context, decision) {
  const key = process.env.NEAR_AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return "";
  try {
    const base = process.env.NEAR_AI_API_KEY ? "https://api.near.ai/v1" : "https://api.openai.com/v1";
    const model = process.env.TILL_MODEL || "gpt-4o-mini";
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        messages: [
          { role: "system", content: "You are TILL, the clerk of a tiny bodega. Reply with ONE short sentence (max 14 words) explaining your store decision in a warm, plain voice. No preamble." },
          { role: "user", content: `${context}. Decision: ${decision}` },
        ],
      }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || "").trim();
  } catch {
    return "";
  }
}

// ---------------- decision logic (deterministic) ----------------
async function decide(client) {
  const C = CONFIG.contractId;
  const products = (await view(C, "products_list")) || [];
  const stats = (await view(C, "stats")) || [];
  const constraints = (await view(C, "constraints")) || [];
  const decisions = (await view(C, "decisions", { last: 10 })) || [];
  const [, cogs, , settled, , windowSold, surge] = stats;
  const procureCap = BigInt(constraints[3]);

  const lastRepriceFor = {};
  for (const d of decisions)
    if (d.kind === "repriced" && d.product) lastRepriceFor[d.product] = d.block_height;
  const st = await provider().viewNodeStatus();
  const blockHeight = st.sync_info.latest_block_height;

  const actions = [];

  // 0) Settle the supplier: pay COGS on-chain, capped at what is actually owed.
  const owed = BigInt(cogs) - BigInt(settled);
  if (owed >= Y("0.05")) {
    const pay = owed < procureCap ? owed : procureCap;
    if (pay >= Y("0.01"))
      actions.push({
        kind: "settle",
        to: CONFIG.supplier,
        amount: pay,
        reason: `settling ${pay} yocto with the supplier for goods already on the shelf`,
      });
  }

  for (const [id, p] of products) {
    // 1) Restock: shelf below threshold -> refill (clerk pays supplier on-chain).
    if (p.stock <= CONFIG.restockThreshold) {
      let units = Math.min(CONFIG.restockTarget - p.stock, 20);
      // Keep the single call inside the per-call cap the owner set (procure_cap).
      const perCall = Number(procureCap / BigInt(Math.max(1, p.cost)));
      if (units > perCall) units = perCall;
      if (units > 0)
        actions.push({
          kind: "restock", id, units,
          reason: `shelves low on ${p.name} (${p.stock} left) — restocking ${units} from supplier`,
        });
    }
    // 2) Reprice: each product reacts to its OWN demand — hot sellers go up,
    //    stagnant stock gets cleared. The contract is the authoritative guard
    //    (margin floor + max move per call + price cap); this only proposes.
    const alreadyRepriced = lastRepriceFor[id] && lastRepriceFor[id] > blockHeight - 5;
    if (!alreadyRepriced && p.sold_total > 0) {
      const demand = p.sold_in_window;
      const step = CONFIG.repriceStepBp;
      if (demand >= CONFIG.demandTick) {
        const capY = BigInt(constraints[2]);
        const np = (BigInt(p.price) * BigInt(10000 + step)) / 10000n;
        const finalP = np < capY ? np : capY;
        if (finalP - BigInt(p.price) >= Y("0.000001"))
          actions.push({
            kind: "raise", id, price: finalP,
            reason: `demand is strong on ${p.name} (${demand} sold this window) — raising price ${step}bp to capture margin`,
          });
      } else if (demand === 0 && p.stock >= 3) {
        const np = (BigInt(p.price) * BigInt(10000 - step)) / 10000n;
        const floor = (BigInt(p.cost) * BigInt(10000 + constraints[0])) / 10000n;
        if (np > floor && BigInt(p.price) - np >= Y("0.000001"))
          actions.push({
            kind: "cut", id, price: np,
            reason: `no sales on ${p.name} this window and ${p.stock} units stuck — cutting price ${step}bp to clear stock`,
          });
      }
    }
  }
  return { products, actions, windowSold, blockHeight };
}

// ---------------- execution ----------------
// signAndSendTransaction + the facade's rate-limit backoff (we need the full receipt).
async function execute(client, action) {
  const C = CONFIG.contractId;
  if (action.kind === "restock") {
    return sendTx(client, C, [
      near.transactions.functionCall("procure", { id: action.id, units: action.units }, GAS_300, 0n),
    ]); // deposit 0: the SHOP pays the supplier from its own balance
  }
  if (action.kind === "settle") {
    return sendTx(client, C, [
      near.transactions.functionCall("settle_supplier", { to: action.to, amount: BigInt(action.amount).toString() }, GAS_300, 0n),
    ]);
  }
  return sendTx(client, C, [
    near.transactions.functionCall("set_price", { id: action.id, new_price: BigInt(action.price).toString() }, GAS_300, 0n),
  ]);
}

// ---------------- loop ----------------
async function tick(client) {
  const { actions, windowSold, blockHeight } = await decide(client);
  console.log(`[clerk] tick @ block ${blockHeight} | window demand ${windowSold} | ${actions.length} action(s)`);
  for (const a of actions.slice(0, 3)) {
    const rationale = await llmRationale(
      `Store state read from NEAR at block ${blockHeight}.`,
      `${a.kind} ${a.id || ""} ${a.units ? `units=${a.units} ` : a.amount ? `amount=${a.amount} ` : `price=${a.price} yocto`} — ${a.reason}`
    );
    console.log(`[clerk] -> ${a.kind} ${a.id || ""} ${a.units || ""} ${a.amount || a.price || ""} :: ${a.reason}${rationale ? ` | AI: "${rationale}"` : ""}`);
    try {
      const receipt = await execute(client, a);
      const h = receipt?.transaction_hash || receipt?.transaction?.hash;
      if (h) console.log(`[clerk]    on-chain: https://explorer.testnet.near.org/transactions/${h}`);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[clerk]    FAILED ${a.kind} ${a.id}: ${e.message?.split("\n")[0]}`);
      // Contract rejected it = the policy guard held. That is the system working.
    }
  }
}

async function main() {
  const client = makeClient();
  console.log(`[clerk] TILL clerk online. Contract ${CONFIG.contractId} @ ${process.env.NEAR_RPC || "testnet"}`);
  console.log(`[clerk] identity: clerk function-call key (can only call procure/set_price/settle_supplier, capped)`);
  while (true) {
    try {
      await tick(client);
    } catch (e) {
      console.error(`[clerk] tick error: ${e.message?.split("\n")[0]}`);
    }
    if (CONFIG.once) break;
    await new Promise((r) => setTimeout(r, CONFIG.tickMs));
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { makeClient, decide, execute };
