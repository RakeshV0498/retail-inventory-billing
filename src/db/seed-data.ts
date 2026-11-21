import type { ProductInput } from "@/services/inventory";

/** Prices are in rupees here for readability; the seed converts to paise. Qty in natural units. */
export interface SeedBatch {
  batchNumber: string;
  /** days from today; negative = already expired; null = no expiry */
  expiryInDays: number | null;
  mfgDaysAgo?: number;
  purchase: number;
  mrp: number;
  selling: number;
  qty: number;
}

export interface SeedProduct {
  product: Omit<ProductInput, "lowStockThreshold"> & { lowStock: number };
  batches: SeedBatch[];
}

export const SEED_PRODUCTS: SeedProduct[] = [
  // ---- Provision store ----
  {
    product: { name: "Ponni Rice (loose)", sku: "GRC-RICE-PONNI", barcode: "8900000000011", category: "grocery", unitType: "kg", allowDecimalQty: true, gstRate: 0, lowStock: 25 },
    batches: [{ batchNumber: "PR-NOV", expiryInDays: 240, mfgDaysAgo: 20, purchase: 52, mrp: 68, selling: 64, qty: 120 }],
  },
  {
    product: { name: "Toor Dal (loose)", sku: "GRC-DAL-TOOR", barcode: "8900000000028", category: "grocery", unitType: "kg", allowDecimalQty: true, gstRate: 0, lowStock: 15 },
    batches: [{ batchNumber: "TD-OCT", expiryInDays: 180, mfgDaysAgo: 40, purchase: 118, mrp: 160, selling: 150, qty: 12.5 }],
  },
  {
    product: { name: "Sunflower Oil 1L Pouch", sku: "GRC-OIL-SUN1L", barcode: "8900000000035", category: "grocery", unitType: "pcs", allowDecimalQty: false, gstRate: 5, lowStock: 10 },
    batches: [
      { batchNumber: "SO-A1", expiryInDays: 25, mfgDaysAgo: 150, purchase: 128, mrp: 165, selling: 158, qty: 6 },
      { batchNumber: "SO-B2", expiryInDays: 170, mfgDaysAgo: 10, purchase: 131, mrp: 170, selling: 162, qty: 40 },
    ],
  },
  {
    product: { name: "Sugar (loose)", sku: "GRC-SUGAR", barcode: "8900000000042", category: "grocery", unitType: "kg", allowDecimalQty: true, gstRate: 5, lowStock: 20 },
    batches: [{ batchNumber: "SG-01", expiryInDays: null, purchase: 38, mrp: 48, selling: 46, qty: 80 }],
  },
  {
    product: { name: "Tata Salt 1kg", sku: "GRC-SALT-1KG", barcode: "8900000000059", category: "grocery", unitType: "pcs", allowDecimalQty: false, gstRate: 0, lowStock: 12 },
    batches: [{ batchNumber: "TS-77", expiryInDays: 400, purchase: 22, mrp: 28, selling: 27, qty: 60 }],
  },
  {
    product: { name: "Parle-G Biscuits 200g", sku: "GRC-PARLEG", barcode: "8900000000066", category: "grocery", unitType: "pcs", allowDecimalQty: false, gstRate: 18, lowStock: 24 },
    batches: [
      { batchNumber: "PG-09", expiryInDays: -5, mfgDaysAgo: 190, purchase: 16, mrp: 20, selling: 20, qty: 8 },
      { batchNumber: "PG-11", expiryInDays: 90, mfgDaysAgo: 60, purchase: 16, mrp: 20, selling: 20, qty: 18 },
    ],
  },
  // ---- Medical shop ----
  {
    product: { name: "Paracetamol 500mg (10 tabs)", sku: "MED-PARA-500", barcode: "8901111000011", category: "medical", unitType: "strip", allowDecimalQty: false, gstRate: 12, lowStock: 30 },
    batches: [
      { batchNumber: "PCM-2301", expiryInDays: -12, mfgDaysAgo: 700, purchase: 10, mrp: 18, selling: 18, qty: 15 },
      { batchNumber: "PCM-2402", expiryInDays: 20, mfgDaysAgo: 500, purchase: 11, mrp: 18, selling: 18, qty: 25 },
      { batchNumber: "PCM-2505", expiryInDays: 380, mfgDaysAgo: 60, purchase: 12, mrp: 20, selling: 20, qty: 120 },
    ],
  },
  {
    product: { name: "Cough Syrup 100ml", sku: "MED-COUGH-100", barcode: "8901111000028", category: "medical", unitType: "bottle", allowDecimalQty: false, gstRate: 12, lowStock: 8 },
    batches: [
      { batchNumber: "CS-A", expiryInDays: 50, mfgDaysAgo: 600, purchase: 58, mrp: 95, selling: 90, qty: 10 },
      { batchNumber: "CS-B", expiryInDays: 300, mfgDaysAgo: 40, purchase: 62, mrp: 98, selling: 95, qty: 24 },
    ],
  },
  {
    product: { name: "Crepe Bandage 6cm", sku: "MED-BANDAGE-6", barcode: "8901111000035", category: "medical", unitType: "pcs", allowDecimalQty: false, gstRate: 12, lowStock: 6 },
    batches: [{ batchNumber: "BND-1", expiryInDays: 700, mfgDaysAgo: 30, purchase: 32, mrp: 60, selling: 55, qty: 18 }],
  },
  {
    product: { name: "Amoxicillin 500mg (10 caps)", sku: "MED-AMOX-500", barcode: "8901111000042", category: "medical", unitType: "strip", allowDecimalQty: false, gstRate: 12, lowStock: 10 },
    batches: [
      { batchNumber: "AMX-12", expiryInDays: 58, mfgDaysAgo: 400, purchase: 70, mrp: 120, selling: 112, qty: 14 },
      { batchNumber: "AMX-15", expiryInDays: 450, mfgDaysAgo: 50, purchase: 74, mrp: 125, selling: 118, qty: 4 },
    ],
  },
  {
    product: { name: "Digital Thermometer", sku: "GEN-THERMO", barcode: "8902222000019", category: "general", unitType: "pcs", allowDecimalQty: false, gstRate: 18, lowStock: 3 },
    batches: [{ batchNumber: "DT-1", expiryInDays: null, purchase: 90, mrp: 220, selling: 199, qty: 9 }],
  },
];

export const SEED_PRICING_RULES = [
  { name: "Expiring within 30 days: 10% off", minDaysToExpiry: 0, maxDaysToExpiry: 30, discountPercent: 1000, category: null },
  { name: "Expiring in 31-60 days: 5% off", minDaysToExpiry: 31, maxDaysToExpiry: 60, discountPercent: 500, category: null },
] as const;
