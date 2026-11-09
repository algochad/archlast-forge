// The same data and the same formatting code in all three apps. The formatters are built inside the helpers, once per call: how this code is usually written.
export interface Product {
  id: number;
  name: string;
  sku: string;
  priceCents: number;
  stock: number;
  createdAt: number;
}

const WORDS = ["Anvil", "Bolt", "Cable", "Drill", "Engine", "Filter", "Gasket", "Hinge", "Insert", "Joint"];

/** 100 products, always the same. */
export function products(): Product[] {
  return Array.from({ length: 100 }, (_, i) => ({
    id: i + 1,
    name: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i + 1}`,
    sku: `SKU-${String(i + 1).padStart(5, "0")}`,
    priceCents: 199 + ((i * 7919) % 250_000),
    stock: (i * 37) % 500,
    createdAt: Date.UTC(2026, 0, 1) + i * 86_400_000,
  }));
}

// CACHE_INTL=1 keeps the formatters between calls (what a careful author does); without it each call builds its own.
const CACHE = process.env.CACHE_INTL === "1"; // read once: process.env is slow to read in Node
const shared = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
const memo = <T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T => {
  if (!CACHE) return make();
  let f = shared.get(key);
  if (!f) shared.set(key, (f = make()));
  return f as T;
};

export function formatMoney(cents: number, currency = "USD") {
  return memo("money:" + currency, () => new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 })).format(cents / 100);
}

export function formatDate(ms: number, timeZone = "UTC") {
  return memo("date:" + timeZone, () => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone })).format(ms);
}
