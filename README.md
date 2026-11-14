# TILL — the bodega that runs itself · NEAR Hackathon 2026 (Track 04 · Autonomous Business)

A store with no staff and no human in the loop. An AI clerk sells, restocks,
reprices and pays the supplier — and **every single action is a live transaction
on NEAR testnet**. The owner sets the rules once; the contract enforces them;
the chain is the ledger. No database, no back-office, nothing to hide behind.

**Live on testnet:** [`shop2.tillshop.testnet`](https://explorer.testnet.near.org/accounts/shop2.tillshop.testnet)
**Live web console (reads the chain straight from your browser):** https://troublesht.github.io/till/

The web console reads everything straight from the contract at each block. Buy
something in the demo and a real signed transaction lands on the testnet
explorer — then watch the clerk react.

## The angle

"Give AI a wallet" projects all solve custody: *how much may the agent spend?*
TILL starts one layer up — **the agent is the whole business** (revenue,
procurement, pricing, settlement) — and answers "what if the agent is
compromised?" architecturally, not by policy.

The clerk's identity is a **function-call access key on the shop account**,
restricted to exactly three methods. It cannot make a plain transfer, create an
account, or manage keys — those actions are not representable by the key. Its
2 NEAR allowance is a **gas budget only**: the three methods take no deposit,
so the clerk holds no spendable funds at all. Supplier payments are issued by
the *shop contract itself* from the shop's own balance, never from the clerk.
The same rules are enforced a second time *inside* the contract, so a
compromised or badly-prompted agent hits a wall at two independent layers.

| If the clerk's brain is hacked, it can still… | …but it can never |
|---|---|
| call `procure` (restock, ≤ `procure_cap` per call) | make a plain NEAR transfer |
| call `set_price` within floor / cap / max-move | price below the margin floor |
| call `settle_supplier` **only** to the locked supplier, **≤ COGS owed** | price above the owner's cap |
| | pay anyone but the supplier in state |
| | touch any other account's funds, rotate keys, change constraints |

## Architecture

```
                     ┌─────────────────────────────────────────────────┐
                     │       shop2.tillshop.testnet (NEAR testnet)     │
 customer ──buy()──▶ │ ┌─────────────────────────────────────────────┐ │
  (testnet key)      │ │  Shop contract (Rust, near-sdk 5.20)        │ │
                     │ │  products · prices · stock · demand windows │ │
 clerk agent ────────▶│ │  P&L ledger · supplier (locked in state)    │ │
 (function-call key,  │ │  policy: margin floor · price cap · max move│ │
  3 methods,          │ │        · procure cap · COGS-owed cap        │ │
  no spendable cap)   │ └───────────────┬───────────────┬─────────────┘ │
                     │        buy()     │               │ Promise::transfer
                     └──────────────────▼───────────────▼───────────────┘
                          revenue in                COGS out → supplier (vendorco.testnet)
```

- **`contract/`** — Rust smart contract (near-sdk 5.20). Owns *all* state: shelf,
  prices, stock, demand windows, the P&L ledger, the supplier address (locked),
  and every clerk decision recorded as a NEP-297 event. Enforces the owner's
  constraints authoritatively and issues the supplier transfer itself.
- **`clerk/`** — the AI clerk. A plain Node agent that reads chain state and
  applies a deterministic business policy (restock low shelves, reprice toward
  demand, settle the supplier), executing via its restricted function-call key.
  **Zero API keys needed** — the brain is deterministic so any judge can run it
  instantly. If you set `OPENAI_API_KEY`/`NEAR_AI_API_KEY`, each decision gains
  a one-line natural-language rationale on top.
- **`server/`** — zero-framework Node server: the web app plus a JSON API that
  reads straight from the contract and signs demo purchases.
- **`web/`** — React 19 + Vite storefront & live P&L console (GSAP + Motion).
  "Buy on-chain" signs a real transaction from a demo customer key.

### The demand loop
Sales fill a shop-wide demand window (`demand_window` units). When it fills, the
clerk sees it next tick: hot windows nudge prices **up** (capped at
`max_move_bp`, more in surge), cold windows nudge prices **down** (never below
`cost × (1 + margin_floor_bp)`). Low stock triggers `procure` (the shop pays the
supplier from its own balance); accumulated COGS triggers `settle_supplier`
(never more than what is actually owed, never to anyone but the locked supplier).

## Run it

Prereqs: Node 18+, Rust + the `wasm32-unknown-unknown` target (only if you
rebuild the contract), and a funded NEAR **testnet** `.env`.

```bash
cp .env.example .env            # fill in your testnet keys
npm install
npm run web:build               # vite production build -> web/dist

# first deploy only (needs Rust + wasm32 target):
npm run contract:build          # cargo build --target wasm32-unknown-unknown --release
node scripts/deploy.js          # (fresh) create shop sub-account, deploy wasm,
                                # add clerk FC key, init, seed the shelf

# the three moving parts (all default to the live shop — shop2.tillshop.testnet):
node clerk/index.js             # the clerk: reads chain, acts on-chain, every TILL_TICK_MS
node server/index.js            # storefront + API on http://localhost:8787
node scripts/demo.js            # end-to-end: customer buys, clerk ticks, P&L + tx links
```

**No `.env`? Still works.** `scripts/demo.js` and the server default to the live
shop, so a bare `node scripts/demo.js` on a fresh clone runs in **observe-only
mode**: it prints the live shelf, the on-chain decision log, the lifetime P&L,
and inspects the clerk's scoped key straight from the chain. Drop testnet keys
into `.env` (see `.env.example`) and the same command drives the full loop —
customer buys, clerk reprices/restocks/settles, security probe BLOCKED.

Open http://localhost:8787 — shelf, prices, stock, P&L and the on-chain decision
log are all live contract state. Buying an item signs a real transaction that
lands on the testnet explorer.

### Deploy on Vercel (full console, no always-on box)

The static site reads the chain straight from the browser (FastNear allows
cross-origin RPC). The one write path — "buy on-chain" — is a **serverless
function** (`api/buy.js`) that signs the purchase with a testnet demo wallet.
So the entire console, including live buying, runs on Vercel with **no
long-running process**. The autonomous clerk keeps running wherever it can
(local / any host) — but you do *not* need it online for the console to show
live P&L or accept a purchase, because the shop's state is on-chain.

```bash
# 1. Import this repo at vercel.com/new  (root dir: project root)
#    vercel.json wires it: build = npm --prefix web run build, output = docs/,
#    api/ → serverless functions, / → index.html (SPA fallback)
# 2. Set one env var on the Vercel project:
#    TILL_CUSTOMER_KEY   =  <your testnet customer key, ed25519:base58>
#    (optional) TILL_CONTRACT / TILL_CUSTOMER / NEAR_RPC — defaults match the live shop
# 3. Deploy. Buy something — a real testnet transaction lands on the explorer.
```

`TILL_CUSTOMER_KEY` is a **testnet** demo credential: it lives only in Vercel
project settings, is never committed, and never ships to the browser.

### Environment (`.env`)

| var | meaning |
|---|---|
| `NEAR_RPC` | testnet RPC (default `https://rpc.testnet.fastnear.com`) |
| `TILL_CONTRACT` | shop contract account (e.g. `shop2.tillshop.testnet`) |
| `TILL_FUND_FROM` | account that pays storage for a brand-new shop account |
| `TILL_OWNER_KEY` | full-access key — deploy + owner methods only |
| `TILL_CLERK_KEY` | clerk key; deploy adds it as an FC key (3 methods, 2 NEAR gas budget — no spendable allowance) |
| `TILL_CUSTOMER_KEY` | demo shopper used by the web "buy" and the demo script |
| `TILL_SUPPLIER` | supplier that receives COGS (e.g. `vendorco.testnet`) |
| `OPENAI_API_KEY` / `NEAR_AI_API_KEY` | **optional** — LLM decision narration |
| `TILL_TICK_MS` | clerk loop period (default 15000) |
| `PORT` | server port (default 8787) |

## What's on-chain (verify it)

Contract: [`shop2.tillshop.testnet`](https://explorer.testnet.near.org/accounts/shop2.tillshop.testnet)

- `stats()` → revenue, inventory COGS, settled to supplier, demand window
- `decisions(last)` → every clerk decision with block height (NEP-297 events)
- `products_list()` → shelf, prices, stock, per-window sales
- `constraints()` → the rules the clerk must obey
- `owner_view()` → owner, clerk key, and the locked supplier

The clerk's access key is visible on the shop account in the explorer: a
`function_call` access restricted to `[procure, set_price, settle_supplier]`
with a 2 NEAR gas budget. **No full-access key exists for the clerk — it is
impossible to construct with this key.** Run `node scripts/demo.js`; its final
step attempts a plain NEAR transfer *with the clerk key* and prints `BLOCKED` —
proof of the scoped key.

## Judge's checklist (5 minutes)

1. **Watch it run** — `node scripts/demo.js` works with **no setup**: it
   defaults to the live shop and runs in observe-only mode, printing the live
   shelf, the on-chain decision log, the lifetime P&L, and the clerk's scoped
   key as the chain stores it. With your own testnet keys in `.env`
   (copy `.env.example`), the same command performs the whole loop on-chain —
   customer buys, clerk reprices toward demand, restocks from the supplier,
   settles COGS on-chain — and then its own transfer attempt gets **BLOCKED**.
   Every transaction links to the testnet explorer.
2. **Open the contract** —
   [shop2.tillshop.testnet](https://explorer.testnet.near.org/accounts/shop2.tillshop.testnet)
   and call `products_list`, `stats`, `decisions`, `constraints`,
   `owner_view`. Every number on the console is read from these views; there is
   no off-chain database.
3. **Inspect the clerk's key** — in the account's access keys, the clerk's
   function-call key lists exactly three methods and a 2 NEAR (gas) allowance.
   Try sending it a plain transfer: the protocol rejects it before any code
   runs.
4. **Read the law** — `contract/src/lib.rs`: every clerk method re-checks the
   signer, enforces the owner's policy, and the supplier address is locked in
   state at init.

## Security model (short version)

1. **Key level** — clerk identity is a function-call access key: 3 methods, no
   spendable cap. Transfers, sub-account creation and key management are not
   representable by the key at all.
2. **Contract level** — every clerk method re-checks
   `signer_account_pk() == clerk_key`, then enforces: `procure_cap` per call,
   margin floor / price cap / max-move on every reprice, and
   `settle_supplier` only to the locked supplier and `≤ COGS owed`. The supplier
   is fixed in state at init and can never be changed by the clerk.
3. **Owner level** — owner methods require `signer_account_pk() == owner_key`.
   The clerk cannot rotate keys, change constraints, or touch the treasury.
4. **The brain is replaceable** — swap the clerk's policy for any LLM and the
   on-chain guarantees are unchanged. Policy in the agent; **law in the
   contract.**

## Limits / next steps
- Testnet only; a production deploy moves settlement to a real supplier and a
  stablecoin price rail.
- NEAR Intents could let the clerk buy from cross-chain suppliers (currently a
  same-chain promise transfer).
- One clerk per store by design (single process); multi-agent procurement would
  layer on the same FC-key model.

## Built with
Rust (near-sdk 5.20) · near-api-js 6.5.1 · Node 18 · React 19 · Vite · Tailwind ·
GSAP · Motion · NEAR testnet

Track 04 — Autonomous Business · NEAR Hackathon 2026 · #NEARHackathon @NEARProtocol
