// TILL deploy (testnet). Run: node scripts/deploy.js
// 1) (fresh run only) create the shop sub-account, funded from an existing account
// 2) deploy contract wasm to TILL_CONTRACT
// 3) add clerk function-call key (procure/set_price/settle_supplier, ZERO allowance)
// 4) init the shop (owner + clerk keys, supplier, policy constraints)
// 5) seed the initial shelf (owner)
const fs = require("fs");
const path = require("path");
const { near, loadEnv, account, view, balance, sendTx, GAS_300, Y, fmt } = require("../lib/near.js");

loadEnv();
const CONTRACT = process.env.TILL_CONTRACT;
const FUND_FROM = process.env.TILL_FUND_FROM; // account that pays storage for a brand-new account
const OWNER_KEY = process.env.TILL_OWNER_KEY;
const CLERK_KEY = process.env.TILL_CLERK_KEY;
const SUPPLIER = process.env.TILL_SUPPLIER || "vendorco.testnet";
if (!CONTRACT || !OWNER_KEY || !CLERK_KEY) {
  console.error("missing TILL_CONTRACT / TILL_OWNER_KEY / TILL_CLERK_KEY in .env");
  process.exit(1);
}
const ownerPk = near.KeyPair.fromString(OWNER_KEY);
const clerkPk = near.KeyPair.fromString(CLERK_KEY);

async function main() {
  const { provider } = require("../lib/near.js");
  let shop = account(CONTRACT, OWNER_KEY);
  let accountExists = false;
  try {
    await provider().viewAccount(CONTRACT); // throws if the account is not on chain
    accountExists = true;
  } catch { /* not on chain yet */ }

  if (accountExists) {
    console.log(`[deploy] account ${CONTRACT} already exists.`);
  } else {
    if (!FUND_FROM) {
      console.error(`[deploy] ${CONTRACT} does not exist and TILL_FUND_FROM is not set — cannot create it.`);
      process.exit(1);
    }
    const funder = account(FUND_FROM, OWNER_KEY);
    console.log(`[deploy] creating ${CONTRACT} (storage + gas paid by ${FUND_FROM})...`);
    // 8 NEAR: covers TLA + wasm storage (~0.72) + demo gas, leaves working balance.
    await sendTx(funder, CONTRACT, [
      near.transactions.createAccount(),
      near.transactions.addKey(ownerPk.publicKey, near.transactions.fullAccessKey()),
      near.transactions.transfer(Y("8")),
    ]);
    console.log("[deploy]   account created.");
  }

  // already initialized?
  try {
    const owner = await view(CONTRACT, "owner_view");
    if (owner) {
      console.log("[deploy] contract already initialized (owner_view:", owner, ") — re-init skipped.");
      return;
    }
  } catch { /* no code yet */ }

  const code = fs.readFileSync(path.join(__dirname, "..", "contract", "target", "wasm32-unknown-unknown", "release", "till.wasm"));
  console.log(`[deploy] deploying ${code.length} bytes of wasm to ${CONTRACT}...`);

  // 1) deploy wasm
  const t1 = await sendTx(shop, CONTRACT, [near.transactions.deployContract(code)]);
  console.log("[deploy]   wasm deployed:", t1.transaction_hash || t1);

  // 2) clerk function-call key: exactly 3 methods, NO spendable cap.
  //    The allowance below is a tiny GAS budget only — it is NOT money the clerk
  //    can spend. Supplier payments are issued by the SHOP contract itself from
  //    the shop's own balance (contract-issued transfer), and settle_supplier can
  //    never pay anyone but the supplier locked in state, and never more than the
  //    COGS actually owed. A plain NEAR transfer is not representable by this key.
  await sendTx(shop, CONTRACT, [
    near.transactions.addKey(clerkPk.publicKey,
    near.transactions.functionCallAccessKey(CONTRACT, ["procure", "set_price", "settle_supplier"], Y("2"))
    ),
  ]);
  console.log("[deploy]   clerk FC key added:", clerkPk.publicKey.toString(), "(3 methods only, gas-budget allowance, no spendable cap)");

  // 3) init
  const initArgs = {
    owner: CONTRACT,
    owner_key: ownerPk.publicKey.toString(),
    clerk_key: clerkPk.publicKey.toString(),
    supplier: SUPPLIER,
    margin_floor_bp: 3000,    // price >= cost * 1.30, always
    max_move_bp: 400,         // max 4% price move per reprice (normal)
    price_cap: Y("2").toString(),        // nothing ever priced above 2 NEAR
    procure_cap: Y("0.3").toString(),    // max one clerk purchase / settlement
    max_stock: 20,
    demand_window: 4,         // 4 units sold shop-wide = one demand tick
    surge_multiplier_bp: 800, // in surge mode the clerk may move up to +12%
  };
  const t3 = await sendTx(shop, CONTRACT, [
    near.transactions.functionCall("new", initArgs, GAS_300, 0n),
  ]);
  console.log("[deploy]   initialized:", t3.transaction_hash || t3);

  // 4) seed shelf (owner; 1 yoctoNEAR attached per call)
  const shelf = [
    { id: "coffee", name: "Cold brew",    emoji: "☕", cost: "0.05", price: "0.12", stock: 8 },
    { id: "bread",  name: "Sourdough",    emoji: "🍞", cost: "0.04", price: "0.09", stock: 8 },
    { id: "juice",  name: "Orange juice", emoji: "🧃", cost: "0.03", price: "0.08", stock: 8 },
    { id: "chips",  name: "Chips",        emoji: "🥔", cost: "0.03", price: "0.08", stock: 8 },
    { id: "water",  name: "Water",        emoji: "💧", cost: "0.01", price: "0.04", stock: 10 },
    { id: "soda",   name: "Soda",         emoji: "🥤", cost: "0.03", price: "0.07", stock: 8 },
  ];
  for (const p of shelf) {
    await sendTx(shop, CONTRACT, [
      near.transactions.functionCall(
        "add_product",
        { id: p.id, name: p.name, emoji: p.emoji, cost: Y(p.cost).toString(), price: Y(p.price).toString(), stock: p.stock },
        GAS_300, 1n
      ),
    ]);
    console.log(`[deploy]   seeded ${p.id}: ${p.stock} units @ ${p.price} NEAR (cost ${p.cost})`);
  }

  console.log(`\n[deploy] DONE. supplier=${SUPPLIER}`);
  console.log("  clerk:  node clerk/index.js");
  console.log("  server: node server/index.js");
}

main().catch((e) => {
  console.error("[deploy] FAILED:", e.message || e);
  process.exit(1);
});
