import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { motion, AnimatePresence } from "motion/react";
import { useTill, buyOnChain } from "./hooks.js";

gsap.registerPlugin(ScrollTrigger);

/* ---------------- shared bits ---------------- */

function Stat({ label, value, unit, tone }) {
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-dim">{label}</div>
      <div className={`font-mono text-2xl mt-1 ${tone || "text-cream"}`}>
        {value}
        {unit && <span className="text-xs text-dim ml-1">{unit}</span>}
      </div>
    </div>
  );
}

function Tag({ children, tone }) {
  return (
    <span className={`font-mono text-[11px] px-2 py-0.5 rounded border ${tone || "border-line text-dim"}`}>
      {children}
    </span>
  );
}

const KIND_STYLE = {
  restock: { emoji: "📦", cls: "text-amber border-amber/40", label: "restock" },
  repriced: { emoji: "🏷️", cls: "text-cream border-line", label: "reprice" },
  supplier_paid: { emoji: "🤝", cls: "text-mint border-mint/40", label: "supplier paid" },
  product_added: { emoji: "🛒", cls: "text-dim border-line", label: "seeded" },
  constraints_updated: { emoji: "📜", cls: "text-dim border-line", label: "rules changed" },
  clerk_key_set: { emoji: "🔑", cls: "text-dim border-line", label: "clerk key set" },
};

/* ---------------- hero ---------------- */

function Hero({ fmt }) {
  const ref = useRef(null);
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from(".hero-line", {
        y: 40,
        opacity: 0,
        duration: 1,
        stagger: 0.12,
        ease: "power3.out",
        delay: 0.1,
      });
      gsap.from(".hero-sub", { opacity: 0, y: 16, duration: 0.8, delay: 0.7 });
      const sign = gsap.utils.toArray(".neon-sign");
      sign.forEach((el, i) =>
        gsap.to(el, {
          opacity: 0.75,
          duration: 0.6 + i * 0.2,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        })
      );
    }, ref);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={ref} className="relative min-h-[92vh] flex flex-col items-center justify-center px-6 overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(255,92,51,0.14),transparent_55%)]" />
      <div className="font-mono text-xs text-dim mb-6 hero-sub tracking-[0.3em] uppercase">
        a bodega on NEAR testnet · nobody's there
      </div>
      <h1 className="text-center leading-[0.9] font-bold">
        <span className="hero-line block text-7xl md:text-9xl neon neon-sign" style={{ fontVariantNumeric: "tabular-nums" }}>
          TILL
        </span>
        <span className="hero-line block text-2xl md:text-4xl text-cream/90 mt-4 font-medium tracking-tight">
          the store that runs itself
        </span>
      </h1>
      <p className="hero-sub max-w-xl text-center text-dim mt-6 leading-relaxed">
        An AI clerk sells, restocks and reprices a tiny bodega — and{" "}
        <span className="text-cream">every single decision is a live transaction on NEAR</span>,
        guarded by a wallet key the clerk can barely spend. The owner sets the rules. The clerk
        obeys them, on-chain.
      </p>
      <div className="hero-sub flex gap-3 mt-8 flex-wrap justify-center">
        <a href="#shop" className="bg-ember text-ink font-semibold px-5 py-2.5 rounded-md hover:brightness-110 transition">
          Shop the shelf ↓
        </a>
        <a href="#ledger" className="border border-line px-5 py-2.5 rounded-md hover:border-cream/50 transition">
          Watch the P&amp;L live
        </a>
      </div>
      <div className="absolute bottom-8 font-mono text-[10px] text-dim/60 animate-bounce">scroll</div>
    </section>
  );
}

/* ---------------- story (pinned beats) ---------------- */

const BEATS = [
  {
    n: "01",
    title: "The owner sets the rules — once",
    body: "Margin floor, price cap, max move per reprice, procurement budget. Written into the contract. The owner never touches a shelf again.",
    tag: "set_constraints() · owner key only",
  },
  {
    n: "02",
    title: "The clerk is a key, not a person",
    body: "The clerk's identity is a function-call access key on the shop account. It can only call procure, set_price and settle_supplier — with a hard spending cap. No transfers. No owner methods. Ever.",
    tag: "add_access_key · 3 methods · capped allowance",
  },
  {
    n: "03",
    title: "It sells, restocks, reprices — on-chain",
    body: "Every sale is a buy() with exact attached NEAR. When a shelf runs low the clerk restocks and pays the supplier. When demand shifts, it nudges prices. Every action is recorded on-chain with a NEP-297 event.",
    tag: "buy() · procure() · set_price() · settle_supplier()",
  },
  {
    n: "04",
    title: "The ledger is the chain",
    body: "Revenue, cost of goods, gross margin, supplier settlements — all readable from the contract by anyone, at any block. No database, no back office, nothing to hide behind.",
    tag: "stats() · decisions() · public RPC",
  },
];

function Story() {
  const ref = useRef(null);
  const pinRef = useRef(null);
  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: ref.current,
          start: "top top",
          end: "+=380%",
          pin: pinRef.current,
          scrub: 1,
        },
      });
      BEATS.forEach((_, i) => {
        if (i === 0) return;
        tl.to(`.beat-${i - 1}`, { opacity: 0, y: -40, duration: 1 }, i - 1)
          .fromTo(`.beat-${i}`, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 1 }, i - 0.6);
      });
    }, ref);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={ref} className="h-screen relative">
      <div ref={pinRef} className="h-full flex items-center justify-center px-6">
        <div className="w-full max-w-3xl">
          <div className="font-mono text-xs text-dim uppercase tracking-[0.3em] mb-10 text-center">
            how the company of zero works
          </div>
          <div className="relative h-[420px]">
            {BEATS.map((b, i) => (
              <div key={b.n} className={`beat-${i} absolute inset-x-0 top-0 ${i > 0 ? "opacity-0" : ""}`}>
                <div className="bg-panel border border-line rounded-xl p-8 md:p-10">
                  <div className="flex items-baseline gap-4">
                    <span className="font-mono text-amber text-sm">{b.n}</span>
                    <h3 className="text-2xl md:text-3xl font-semibold">{b.title}</h3>
                  </div>
                  <p className="text-dim mt-4 leading-relaxed text-lg">{b.body}</p>
                  <div className="mt-6">
                    <Tag tone="border-amber/40 text-amber">{b.tag}</Tag>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-center gap-1.5 mt-8">
            {BEATS.map((b, i) => (
              <span key={i} className="w-8 h-1 rounded bg-line" />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- shop ---------------- */

function Shop({ state, fmt }) {
  const [busy, setBusy] = useState(null);
  const [lastTx, setLastTx] = useState(null);
  const products = state?.products || [];

  const buy = async (p) => {
    setBusy(p.id);
    try {
      const r = await buyOnChain(p.id, 1);
      setLastTx(r);
    } catch (e) {
      setLastTx({ error: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="shop" className="px-6 py-24 max-w-6xl mx-auto">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-10">
        <div>
          <div className="font-mono text-xs text-dim uppercase tracking-[0.3em] mb-2">open 24/7 · staff: 0</div>
          <h2 className="text-4xl md:text-5xl font-bold">
            The shelf <span className="text-ember">right now</span>
          </h2>
        </div>
        {state?.stats && (
          <div className="font-mono text-xs text-dim">
            window demand: <span className="text-amber">{state.stats.windowSold}</span> / {state?.constraints?.demandWindow}
            {state.stats.surge && <Tag tone="border-ember text-ember ml-2">SURGE</Tag>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {products.map((p) => (
          <motion.div
            key={p.id}
            whileHover={{ y: -4 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="bg-panel border border-line rounded-xl p-5 flex flex-col"
          >
            <div className="flex items-start justify-between">
              <span className="text-4xl">{p.emoji}</span>
              <span className={`font-mono text-[11px] ${p.stock <= 2 ? "text-ember" : "text-dim"}`}>
                {p.stock} in stock
              </span>
            </div>
            <div className="mt-3 font-semibold text-lg">{p.name}</div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="font-mono text-amber text-xl neon-sign">{fmt(p.price)}</span>
              <span className="font-mono text-xs text-dim">NEAR</span>
            </div>
            <button
              onClick={() => buy(p)}
              disabled={busy === p.id || p.stock === 0}
              className="mt-5 w-full bg-cream/10 hover:bg-cream/20 disabled:opacity-40 border border-line rounded-md py-2.5 font-mono text-sm transition"
            >
              {busy === p.id ? "signing & sending…" : p.stock === 0 ? "out of stock" : "buy on-chain"}
            </button>
          </motion.div>
        ))}
        {products.length === 0 && (
          <div className="col-span-full text-dim font-mono text-sm">
            {state ? "reading the shelf…" : "connecting to the chain…"}
          </div>
        )}
      </div>

      <AnimatePresence>
        {lastTx && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            className="mt-6 bg-panel border border-mint/40 rounded-lg px-5 py-4 font-mono text-sm flex items-center gap-3 flex-wrap"
          >
            {lastTx.error ? (
              <span className="text-ember">✕ {lastTx.error}</span>
            ) : (
              <>
                <span className="text-mint neon-mint">✓ paid on-chain</span>
                <span className="text-dim">{lastTx.product} × {lastTx.qty}</span>
                <a href={lastTx.explorer} target="_blank" rel="noreferrer" className="text-amber hover:underline">
                  view in explorer →
                </a>
              </>
            )}
            <button onClick={() => setLastTx(null)} className="ml-auto text-dim hover:text-cream">
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/* ---------------- ledger / console ---------------- */

function Ledger({ state, fmt, flash }) {
  const s = state?.stats;
  const decisions = [...(state?.decisions || [])].reverse().slice(0, 12);
  const c = state?.constraints;
  const marginBp = s && s.revenue > 0 ? (Number(s.gross) / Number(s.revenue)) * 100 : null;

  return (
    <section id="ledger" className={`px-6 py-24 max-w-6xl mx-auto ${flash ? "tick-flash" : ""}`}>
      <div className="mb-10">
        <div className="font-mono text-xs text-dim uppercase tracking-[0.3em] mb-2">
          no database · the chain is the ledger
        </div>
        <h2 className="text-4xl md:text-5xl font-bold">
          Live P&amp;L <span className="text-mint neon-mint">console</span>
        </h2>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-4">
        <Stat label="revenue" value={fmt(s?.revenue)} unit="NEAR" tone="text-cream" />
        <Stat label="cost of goods" value={fmt(s?.cogs)} unit="NEAR" tone="text-dim" />
        <Stat label="gross margin" value={s?.gross != null ? fmt(s.gross) : "—"} unit="NEAR" tone="text-mint" />
        <Stat label="settled to supplier" value={fmt(s?.settled)} unit="NEAR" tone="text-amber" />
      </div>
      {marginBp != null && (
        <div className="font-mono text-xs text-dim mb-8">
          effective margin <span className="text-mint">{marginBp.toFixed(1)}%</span> · contract
          margin floor <span className="text-cream">{(c?.marginFloorBp / 100).toFixed(0)}%</span> · price cap{" "}
          <span className="text-cream">{fmt(c?.priceCap, 2)} NEAR</span> · procurement cap{" "}
          <span className="text-cream">{fmt(c?.procureCap, 3)} NEAR</span>
        </div>
      )}

      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <span className="font-mono text-xs text-dim uppercase tracking-[0.2em]">
            clerk decision log · on-chain (NEP-297)
          </span>
          <span className="font-mono text-[11px] text-dim">{state?.contract}</span>
        </div>
        <div className="divide-y divide-line">
          {decisions.length === 0 && (
            <div className="px-5 py-8 font-mono text-sm text-dim">
              waiting for the clerk's first move…
            </div>
          )}
          {decisions.map((d) => {
            const st = KIND_STYLE[d.kind] || KIND_STYLE.clerk_key_set;
            // contract log lines carry raw yocto amounts — render them as NEAR
            // handles both "A -> B yocto" (price transition) and "N yocto"
            const pretty = (d.detail || "").replace(
              /(\d{16,})\s*(?:->\s*(\d{16,}))?\s*yocto/g,
              (_m, a, b) => (b ? `${fmt(a, 4)} -> ${fmt(b, 4)} NEAR` : `${fmt(a, 4)} NEAR`)
            );
            return (
              <div key={d.seq} className="px-5 py-3 flex items-start gap-3">
                <span className="text-lg leading-6">{st.emoji}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-mono text-[11px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                    {d.product && <span className="font-mono text-xs text-dim">#{d.product}</span>}
                    <span className="font-mono text-[10px] text-dim/60 ml-auto">
                      block {d.block_height} · {d.by}
                    </span>
                  </div>
                  <div className="text-sm text-cream/85 mt-1 leading-snug">{pretty}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------------- security ---------------- */

const CAN = [
  "procure — restock a shelf, paying the supplier (capped per call)",
  "set_price — move a price within the owner's floor, cap and max-move",
  "settle_supplier — pay COGS owed to the supplier, never more",
];
const CANT = [
  "plain NEAR transfers — no such key, no such method",
  "change the owner, keys, or constraints — owner key only",
  "price below the margin floor or above the cap — contract rejects",
  "move more than the cap in one call — contract rejects",
  "touch any other account's funds — the key lives on the shop only",
];

function Security() {
  const ref = useRef(null);
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from(".sec-item", {
        scrollTrigger: { trigger: ref.current, start: "top 80%" },
        y: 24,
        opacity: 0,
        duration: 0.5,
        stagger: 0.07,
        ease: "power2.out",
      });
    }, ref);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={ref} className="px-6 py-24 max-w-6xl mx-auto">
      <div className="mb-10">
        <div className="font-mono text-xs text-dim uppercase tracking-[0.3em] mb-2">trust, but verify</div>
        <h2 className="text-4xl md:text-5xl font-bold">
          Even a <span className="text-ember">hacked</span> clerk is safe
        </h2>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-panel border border-mint/30 rounded-xl p-6">
          <div className="font-mono text-xs text-mint mb-4 uppercase tracking-[0.2em]">the clerk key can</div>
          <ul className="space-y-3">
            {CAN.map((x) => (
              <li key={x} className="sec-item flex gap-3 text-sm text-cream/85">
                <span className="text-mint">✓</span> {x}
              </li>
            ))}
          </ul>
        </div>
        <div className="bg-panel border border-ember/30 rounded-xl p-6">
          <div className="font-mono text-xs text-ember mb-4 uppercase tracking-[0.2em]">…and can never</div>
          <ul className="space-y-3">
            {CANT.map((x) => (
              <li key={x} className="sec-item flex gap-3 text-sm text-cream/85">
                <span className="text-ember">✕</span> {x}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="sec-item text-dim text-sm mt-6 max-w-2xl leading-relaxed">
        The policy lives in the contract, not in the agent. The clerk's prompts, weights and
        brain can be swapped, bribed or stolen — the on-chain rules are the same. That is the
        difference between an employee and an <span className="text-cream">institution</span>.
      </p>
    </section>
  );
}

/* ---------------- marquee + footer ---------------- */

function Marquee() {
  const items = [
    "OPEN 24/7", "STAFF: ZERO", "EVERY SALE ON-CHAIN", "CLERK: 1 KEY, 3 METHODS",
    "LEDGER = BLOCKCHAIN", "MARGIN FLOOR ENFORCED", "SUPPLIER PAID ON-CHAIN", "NO BACK OFFICE",
  ];
  const row = [...items, ...items];
  return (
    <div className="border-y border-line py-3 overflow-hidden bg-panel/50">
      <div className="marquee-track gap-10">
        {row.map((t, i) => (
          <span key={i} className="font-mono text-xs text-dim whitespace-nowrap tracking-[0.25em]">
            {t} <span className="text-ember ml-10">✦</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Footer({ state }) {
  return (
    <footer className="px-6 py-14 border-t border-line">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-6">
        <div>
          <div className="text-2xl font-bold neon neon-sign">TILL</div>
          <div className="text-dim text-sm mt-1">
            built at <span className="text-cream">NEAR Hackathon</span> · track 04 — Autonomous Business
          </div>
        </div>
        <div className="font-mono text-xs text-dim space-y-1">
          <div>contract: <span className="text-cream">{state?.contract || "tillshop.testnet"}</span></div>
          <div>
            explorer:{" "}
            <a className="text-amber hover:underline" target="_blank" rel="noreferrer"
              href="https://explorer.testnet.near.org/accounts/tillshop.testnet">
              tillshop.testnet →
            </a>
          </div>
          <div className="text-dim/60">testnet demo · nothing here is money</div>
        </div>
      </div>
    </footer>
  );
}

/* ---------------- app ---------------- */

export default function App() {
  const { state, error, flash, fmt } = useTill();

  useEffect(() => {
    const t = setTimeout(() => ScrollTrigger.refresh(), 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="grain min-h-screen">
      <Hero fmt={fmt} />
      <Marquee />
      <Story />
      <Shop state={state} fmt={fmt} />
      <Ledger state={state} fmt={fmt} flash={flash} />
      <Security />
      <Footer state={state} />
      {error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-panel border border-ember/50 rounded-md px-4 py-2 font-mono text-xs text-ember z-50">
          chain read error: {error}
        </div>
      )}
    </div>
  );
}
