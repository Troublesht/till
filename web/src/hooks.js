import { useEffect, useRef, useState } from "react";

// 1 NEAR = 10^24 yoctoNEAR. Keep 6 decimal places of precision:
// divide by 10^18 as a BigInt (micro-integer), then scale by 1e6.
const fmt = (yocto, dp = 4) => {
  if (yocto == null) return "0";
  const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
  return n.toFixed(dp).replace(/\.?0+$/, "") || "0";
};

export function useTill() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(false);
  const prev = useRef(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await fetch("/api/state");
        const j = await r.json();
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
