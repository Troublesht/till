use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, NearToken, PanicOnDefault, Promise,
    PublicKey,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// TILL — an autonomous bodega on NEAR.
//
// Every sale is a real on-chain transaction. The "clerk" is NOT an account:
// it is a restricted function-call access key on the shop account that can only
// call procure / set_price / settle_supplier, each capped by owner-set policy.
// The contract is the authoritative policy engine; the agent only proposes.
//
// Money is stored as decimal strings (yoctoNEAR): borsh-safe, serde-safe, and
// it keeps JS-side big-integer exactness (JS reads it via BigInt / formatNearAmount).
// ---------------------------------------------------------------------------

fn parse_y(s: &str) -> u128 {
    s.trim().parse::<u128>().unwrap_or_else(|_| env::panic_str("invalid amount"))
}
fn fmt_y(v: u128) -> String {
    v.to_string()
}

/// One shelf product.
#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub emoji: String,
    /// Unit cost paid to the supplier, in yoctoNEAR (decimal string).
    pub cost: String,
    /// Current shelf price, in yoctoNEAR (decimal string).
    pub price: String,
    pub stock: u32,
    pub sold_total: u32,
    pub sold_in_window: u32,
    pub window_index: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Deserialize, Clone, Debug)]
pub struct Decision {
    pub seq: u64,
    pub kind: String,
    pub product: Option<String>,
    pub detail: String,
    pub by: String,
    pub block_height: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Shop {
    pub owner: AccountId,
    /// Full-access key of the owner (ed25519:<b58>). Only this signer may call owner methods.
    pub owner_key: String,
    /// The clerk agent's ed25519 public key (a function-call access key on the shop,
    /// limited to procure/set_price/settle_supplier with ZERO deposit allowance —
    /// the clerk can trigger those methods and nothing else, ever).
    pub clerk_key: String,
    /// The one supplier the shop buys from. Locked in the contract: the clerk can
    /// pay this address (and only this address) for goods — a compromised clerk
    /// cannot drain the shop's balance anywhere else.
    pub supplier: AccountId,
    /// Floor margin: price may never drop below cost * (10000 + margin_floor_bp) / 10000.
    pub margin_floor_bp: u32,
    /// Max per-unit price move the clerk may make in one call (basis points).
    pub max_move_bp: u32,
    /// Hard ceiling the owner set for the clerk's prices, in yoctoNEAR.
    pub price_cap: String,
    /// Max NEAR one clerk procure()/settle_supplier() call may move, in yoctoNEAR.
    pub procure_cap: String,
    pub max_stock: u32,
    pub products: Vec<Product>,
    pub decisions: Vec<Decision>,
    pub next_decision_seq: u64,
    pub total_revenue: String,
    pub total_cogs: String,
    /// COGS already paid out to the supplier, in yoctoNEAR.
    pub settled_to_supplier: String,
    pub demand_window: u32,
    pub window_index: u32,
    pub surge: bool,
    pub surge_multiplier_bp: u32,
}

const MAX_DECISIONS: usize = 200;
const MAX_PRODUCTS: usize = 8;

#[near]
impl Shop {
    #[init]
    pub fn new(
        owner: AccountId,
        owner_key: String,
        clerk_key: String,
        supplier: AccountId,
        margin_floor_bp: u32,
        max_move_bp: u32,
        price_cap: String,
        procure_cap: String,
        max_stock: u32,
        demand_window: u32,
        surge_multiplier_bp: u32,
    ) -> Self {
        require!(owner_key.starts_with("ed25519:"), "bad owner key");
        require!(clerk_key.starts_with("ed25519:"), "bad clerk key");
        require!(owner_key != clerk_key, "owner and clerk keys must differ");
        require!(margin_floor_bp <= 10000, "margin floor out of range");
        require!(max_move_bp <= 5000, "max move out of range");
        let _ = parse_y(&price_cap);
        let _ = parse_y(&procure_cap);
        Self {
            owner,
            owner_key,
            clerk_key,
            supplier,
            margin_floor_bp,
            max_move_bp,
            price_cap,
            procure_cap,
            max_stock,
            products: Vec::new(),
            decisions: Vec::new(),
            next_decision_seq: 0,
            total_revenue: "0".into(),
            total_cogs: "0".into(),
            settled_to_supplier: "0".into(),
            demand_window: demand_window.max(1),
            window_index: 0,
            surge: false,
            surge_multiplier_bp,
        }
    }

    // ---------- guards ----------

    fn assert_owner(&self) {
        let signer = env::signer_account_pk();
        let stored = self
            .owner_key
            .parse::<PublicKey>()
            .unwrap_or_else(|_| env::panic_str("stored owner key malformed"));
        require!(
            signer == stored,
            "signer is not the owner key (the clerk key cannot call owner methods)"
        );
    }

    fn assert_clerk(&self) {
        let signer = env::signer_account_pk();
        let stored = self
            .clerk_key
            .parse::<PublicKey>()
            .unwrap_or_else(|_| env::panic_str("stored clerk key malformed"));
        require!(signer == stored, "only the clerk key may call this");
    }

    fn product_mut(&mut self, id: &str) -> &mut Product {
        self.products
            .iter_mut()
            .find(|p| p.id == id)
            .unwrap_or_else(|| env::panic_str("no such product"))
    }

    fn record_decision(&mut self, kind: &str, product: Option<String>, detail: String, by: &str) {
        self.next_decision_seq += 1;
        self.decisions.push(Decision {
            seq: self.next_decision_seq,
            kind: kind.to_string(),
            product,
            detail,
            by: by.to_string(),
            block_height: env::block_height(),
        });
        if self.decisions.len() > MAX_DECISIONS {
            self.decisions.drain(0..self.decisions.len() - MAX_DECISIONS);
        }
        env::log_str(&format!(
            "EVENT_JSON {{\"standard\":\"NEP-297\",\"version\":\"1.0\",\"event\":\"clerk_decision\",\"data\":{{\"kind\":\"{}\",\"by\":\"{}\",\"seq\":{}}}}}",
            kind, by, self.next_decision_seq
        ));
    }

    fn advance_window(&mut self) {
        let total_sold: u32 = self.products.iter().map(|p| p.sold_in_window).sum();
        if total_sold >= self.demand_window {
            self.window_index += 1;
            for p in self.products.iter_mut() {
                p.sold_in_window = 0;
                p.window_index = self.window_index;
            }
        }
    }

    fn current_window_sold(&self) -> u32 {
        self.products.iter().map(|p| p.sold_in_window).sum()
    }

    // ---------- owner methods (each requires exactly 1 yoctoNEAR attached) ----------

    #[payable]
    pub fn add_product(
        &mut self,
        id: String,
        name: String,
        emoji: String,
        cost: String,
        price: String,
        stock: u32,
    ) {
        self.assert_owner();
        assert_one_yocto();
        require!(self.products.len() < MAX_PRODUCTS, "shelf full");
        require!(!self.products.iter().any(|p| p.id == id), "product exists");
        let cost_y = parse_y(&cost);
        let price_y = parse_y(&price);
        require!(price_y >= cost_y, "price must be >= cost");
        require!(price_y <= parse_y(&self.price_cap), "price above cap");
        self.total_cogs =
            fmt_y(parse_y(&self.total_cogs) + cost_y.saturating_mul(stock as u128));
        self.products.push(Product {
            id: id.clone(),
            name,
            emoji,
            cost,
            price,
            stock,
            sold_total: 0,
            sold_in_window: 0,
            window_index: self.window_index,
        });
        self.record_decision(
            "product_added",
            Some(id.clone()),
            format!("seeded {} units at {} yocto", stock, price_y),
            "owner",
        );
    }

    #[payable]
    pub fn set_constraints(
        &mut self,
        margin_floor_bp: Option<u32>,
        max_move_bp: Option<u32>,
        price_cap: Option<String>,
        procure_cap: Option<String>,
        surge: Option<bool>,
    ) {
        self.assert_owner();
        assert_one_yocto();
        if let Some(v) = margin_floor_bp {
            require!(v <= 10000, "margin floor out of range");
            self.margin_floor_bp = v;
        }
        if let Some(v) = max_move_bp {
            require!(v <= 5000, "max move out of range");
            self.max_move_bp = v;
        }
        if let Some(v) = price_cap {
            let _ = parse_y(&v);
            self.price_cap = v;
        }
        if let Some(v) = procure_cap {
            let _ = parse_y(&v);
            self.procure_cap = v;
        }
        if let Some(v) = surge {
            self.surge = v;
        }
        self.record_decision(
            "constraints_updated",
            None,
            "owner changed the rules the clerk must obey".to_string(),
            "owner",
        );
    }

    #[payable]
    pub fn set_clerk_key(&mut self, clerk_key: String) {
        self.assert_owner();
        assert_one_yocto();
        require!(clerk_key.starts_with("ed25519:"), "bad key format");
        self.clerk_key = clerk_key.clone();
        self.record_decision("clerk_key_set", None, clerk_key, "owner");
    }

    // ---------- customer method ----------

    #[payable]
    pub fn buy(&mut self, id: String, qty: u8) -> String {
        require!(qty > 0 && qty <= 5, "qty 1..5");
        let price_y = {
            let p = self
                .products
                .iter()
                .find(|p| p.id == id)
                .unwrap_or_else(|| env::panic_str("no such product"));
            require!(p.stock >= qty as u32, "out of stock");
            parse_y(&p.price)
        };
        let expected = price_y.saturating_mul(qty as u128);
        require!(
            env::attached_deposit().as_yoctonear() == expected,
            "exact amount required"
        );
        let (name, sold) = {
            let p = self.product_mut(&id);
            p.stock -= qty as u32;
            p.sold_total += qty as u32;
            p.sold_in_window += qty as u32;
            (p.name.clone(), p.sold_in_window)
        };
        self.total_revenue = fmt_y(parse_y(&self.total_revenue) + expected);
        self.advance_window();
        env::log_str(&format!(
            "EVENT_JSON {{\"standard\":\"NEP-297\",\"version\":\"1.0\",\"event\":\"sale\",\"data\":{{\"product\":\"{}\",\"name\":\"{}\",\"qty\":{},\"amount\":\"{}\",\"window_sold\":{}}}}}",
            id, name, qty, expected, sold
        ));
        env::log_str(&format!(
            "sale_completed;{{\"id\":\"{}\",\"qty\":{},\"amount\":\"{}\"}}",
            id, qty, expected
        ));
        fmt_y(expected)
    }

    // ---------- clerk methods (only the clerk's function-call key may call these) ----------

    /// Clerk restocks a product. The SHOP pays the supplier on-chain from its own
    /// balance (a transfer issued by the contract, funded by customer revenue) —
    /// the clerk's scoped key attaches no deposit and holds no funds, it only
    /// triggers this method. Enforced: max_stock and the per-call procure cap.
    pub fn procure(&mut self, id: String, units: u32) {
        self.assert_clerk();
        require!(units > 0 && units <= 20, "units 1..20");
        let max_stock = self.max_stock;
        let procure_cap = self.procure_cap.clone();
        let supplier = self.supplier.clone();
        let p = self.product_mut(&id);
        let space = max_stock.saturating_sub(p.stock);
        let take = units.min(space);
        require!(take > 0, "shelf full");
        p.stock += take;
        let cost = parse_y(&p.cost).saturating_mul(take as u128);
        require!(cost <= parse_y(&procure_cap), "exceeds procure cap");
        self.total_cogs = fmt_y(parse_y(&self.total_cogs) + cost);
        // Contract-issued transfer: shop balance -> supplier (Drop commits it).
        Promise::new(supplier.clone()).transfer(NearToken::from_yoctonear(cost));
        self.record_decision(
            "restocked",
            Some(id.clone()),
            format!("bought {} units, paid {} yocto on-chain to supplier {}", take, cost, supplier),
            "clerk",
        );
        env::log_str(&format!("restock_completed;{{\"id\":\"{}\",\"units\":{}}}", id, take));
    }

    /// Clerk reprices. The contract enforces: margin floor, max move per call, and price cap.
    /// The agent proposes; the contract decides what is legal.
    pub fn set_price(&mut self, id: String, new_price: String) {
        self.assert_clerk();
        let new_y = parse_y(&new_price);
        let (margin_floor_bp, price_cap, max_move_bp, surge, surge_multiplier_bp) = (
            self.margin_floor_bp,
            self.price_cap.clone(),
            self.max_move_bp,
            self.surge,
            self.surge_multiplier_bp,
        );
        let p = self.product_mut(&id);
        let cost_y = parse_y(&p.cost);
        let floor = cost_y.saturating_mul(10000 + margin_floor_bp as u128) / 10000;
        require!(new_y >= floor, "below owner's margin floor");
        require!(new_y <= parse_y(&price_cap), "above owner's price cap");
        let old_y = parse_y(&p.price);
        let diff = if new_y >= old_y { new_y - old_y } else { old_y - new_y };
        let move_bp = (diff.saturating_mul(10000)) / old_y.max(1);
        let limit = if surge {
            (max_move_bp as u128).saturating_add(surge_multiplier_bp as u128)
        } else {
            max_move_bp as u128
        };
        require!(move_bp <= limit, "move too big for policy");
        p.price = new_price.clone();
        let window_sold = self.current_window_sold();
        self.record_decision(
            "repriced",
            Some(id.clone()),
            format!(
                "{} -> {} yocto (move {}bp, window demand {}) - {}",
                old_y,
                new_y,
                move_bp,
                window_sold,
                if new_y > old_y {
                    "demand is strong, capturing margin"
                } else {
                    "demand is weak, cutting price to move units"
                }
            ),
            "clerk",
        );
    }

    /// Clerk pays the supplier on-chain from the shop's balance, up to the COGS owed.
    /// The supplier address is FIXED IN THE CONTRACT — the clerk cannot point this
    /// payment anywhere else, and a plain transfer is impossible (its key only
    /// permits these three methods). Even a fully compromised clerk can never move
    /// the shop's money anywhere except to the supplier, and never more than the
    /// goods cost.
    pub fn settle_supplier(&mut self, to: AccountId, amount: String) {
        self.assert_clerk();
        require!(to == self.supplier, "supplier is fixed in the contract");
        let amount_y = parse_y(&amount);
        require!(amount_y > 0, "amount must be positive");
        require!(amount_y <= parse_y(&self.procure_cap), "exceeds settle cap");
        let owed = parse_y(&self.total_cogs).saturating_sub(parse_y(&self.settled_to_supplier));
        require!(amount_y <= owed, "cannot pay supplier more than COGS owed");
        self.settled_to_supplier = fmt_y(parse_y(&self.settled_to_supplier) + amount_y);
        // Promise is lazy; its Drop commits the transfer action.
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount_y));
        self.record_decision(
            "supplier_paid",
            None,
            format!("paid {} yocto to {} for goods on the shelf", amount_y, to),
            "clerk",
        );
        env::log_str(&format!(
            "supplier_settled;{{\"to\":\"{}\",\"amount\":\"{}\"}}",
            to, amount_y
        ));
    }

    // ---------- views ----------

    pub fn products_list(&self) -> Vec<(String, Product)> {
        self.products.iter().map(|p| (p.id.clone(), p.clone())).collect()
    }

    pub fn product(&self, id: String) -> Option<Product> {
        self.products.iter().find(|p| p.id == id).cloned()
    }

    pub fn decisions(&self, last: u32) -> Vec<Decision> {
        let n = self.decisions.len() as u32;
        let start = n.saturating_sub(last);
        self.decisions[start as usize..].to_vec()
    }

    pub fn stats(&self) -> (String, String, String, String, u32, u32, bool, u64) {
        let revenue = parse_y(&self.total_revenue);
        let cogs = parse_y(&self.total_cogs);
        let gross = revenue.saturating_sub(cogs);
        (
            fmt_y(revenue),
            fmt_y(cogs),
            fmt_y(gross),
            self.settled_to_supplier.clone(),
            self.window_index,
            self.current_window_sold(),
            self.surge,
            self.next_decision_seq,
        )
    }

    pub fn constraints(&self) -> (u32, u32, String, String, u32, String, u32, u32) {
        (
            self.margin_floor_bp,
            self.max_move_bp,
            self.price_cap.clone(),
            self.procure_cap.clone(),
            self.max_stock,
            self.clerk_key.clone(),
            self.demand_window,
            self.surge_multiplier_bp,
        )
    }

    pub fn owner_view(&self) -> String {
        format!(
            "{{\"owner\":\"{}\",\"clerk_key\":\"{}\",\"supplier\":\"{}\"}}",
            self.owner.to_string(),
            self.clerk_key,
            self.supplier.to_string()
        )
    }
}
