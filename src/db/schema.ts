import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Conventions: money = integer paise, quantity = integer milli-units (1 kg = 1000),
 * dates = ISO `YYYY-MM-DD`, timestamps = ISO strings. GST prices are inclusive.
 */

// Defined in lib/constants (no DB imports) and re-exported here; relative path because drizzle-kit loads this file.
import { CATEGORIES, UNIT_TYPES } from "../lib/constants";
export { CATEGORIES, UNIT_TYPES };
export const PAYMENT_MODES = ["cash", "upi", "card", "split", "credit"] as const;
/** How a customer can settle dues (credit itself is not a way to pay). */
export const DUES_PAYMENT_MODES = ["cash", "upi", "card"] as const;
export const MOVEMENT_TYPES = ["purchase_in", "sale_out", "return", "expired_wastage", "adjustment"] as const;
export const DISCOUNT_TYPES = ["none", "percent", "flat"] as const;

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    category: text("category", { enum: CATEGORIES }).notNull(),
    unitType: text("unit_type", { enum: UNIT_TYPES }).notNull(),
    allowDecimalQty: integer("allow_decimal_qty", { mode: "boolean" }).notNull().default(false),
    /** milli-units */
    lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
    gstRate: integer("gst_rate").notNull().default(0),
    hsnCode: text("hsn_code"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("products_sku_uq").on(t.sku),
    uniqueIndex("products_barcode_uq").on(t.barcode),
    index("products_name_idx").on(t.name),
    check("products_gst_chk", sql`${t.gstRate} in (0,5,12,18)`),
    check("products_threshold_chk", sql`${t.lowStockThreshold} >= 0`),
  ],
);

export const batches = sqliteTable(
  "batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    batchNumber: text("batch_number").notNull(),
    mfgDate: text("mfg_date"),
    expiryDate: text("expiry_date"),
    purchasePrice: integer("purchase_price").notNull(),
    mrp: integer("mrp").notNull(),
    sellingPrice: integer("selling_price").notNull(),
    /** milli-units */
    quantityAvailable: integer("quantity_available").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("batches_product_batch_uq").on(t.productId, t.batchNumber),
    index("batches_fefo_idx").on(t.productId, t.expiryDate),
    check("batches_qty_chk", sql`${t.quantityAvailable} >= 0`),
    check("batches_price_chk", sql`${t.purchasePrice} >= 0 and ${t.mrp} >= 0 and ${t.sellingPrice} >= 0`),
  ],
);

/** People who buy on credit (udhaar). Balances are computed from invoices and payments, never stored. */
export const customers = sqliteTable(
  "customers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** digits only; unique when present */
    phone: text("phone"),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customers_phone_uq").on(t.phone), index("customers_name_idx").on(t.name)],
);

/** Money received from a customer against their dues. */
export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    /** paise, always positive */
    amount: integer("amount").notNull(),
    mode: text("mode", { enum: DUES_PAYMENT_MODES }).notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("payments_customer_idx").on(t.customerId), index("payments_created_idx").on(t.createdAt), check("payments_amount_chk", sql`${t.amount} > 0`)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceNumber: text("invoice_number").notNull(),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    subtotal: integer("subtotal").notNull(),
    discountTotal: integer("discount_total").notNull(),
    taxTotal: integer("tax_total").notNull(),
    roundOff: integer("round_off").notNull().default(0),
    grandTotal: integer("grand_total").notNull(),
    paymentMode: text("payment_mode", { enum: PAYMENT_MODES }).notNull(),
    cashAmount: integer("cash_amount").notNull().default(0),
    upiAmount: integer("upi_amount").notNull().default(0),
    cardAmount: integer("card_amount").notNull().default(0),
    /** Part of the grand total owed by the customer (udhaar); 0 for fully paid bills. */
    creditAmount: integer("credit_amount").notNull().default(0),
    customerId: integer("customer_id").references(() => customers.id),
    status: text("status", { enum: ["paid", "void"] }).notNull().default("paid"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.invoiceNumber),
    index("invoices_created_idx").on(t.createdAt),
    index("invoices_customer_idx").on(t.customerId),
  ],
);

export const invoiceItems = sqliteTable(
  "invoice_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoices.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id),
    productName: text("product_name").notNull(),
    batchNumber: text("batch_number").notNull(),
    unitType: text("unit_type").notNull(),
    /** milli-units */
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    purchasePrice: integer("purchase_price").notNull(),
    discountType: text("discount_type", { enum: DISCOUNT_TYPES }).notNull().default("none"),
    discountValue: integer("discount_value").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    gstRate: integer("gst_rate").notNull(),
    taxableAmount: integer("taxable_amount").notNull(),
    taxAmount: integer("tax_amount").notNull(),
    lineTotal: integer("line_total").notNull(),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId), check("invoice_items_qty_chk", sql`${t.quantity} > 0`)],
);

export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id),
    type: text("type", { enum: MOVEMENT_TYPES }).notNull(),
    /** signed milli-units */
    quantityDelta: integer("quantity_delta").notNull(),
    referenceType: text("reference_type"),
    referenceId: integer("reference_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("movements_batch_idx").on(t.batchId), index("movements_created_idx").on(t.createdAt)],
);

/** Optional near-expiry markdown suggestions applied at POS. */
export const pricingRules = sqliteTable("pricing_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** Rule matches when days-to-expiry is within [min, max]. */
  minDaysToExpiry: integer("min_days_to_expiry").notNull().default(0),
  maxDaysToExpiry: integer("max_days_to_expiry").notNull(),
  /** hundredths of a percent (10% = 1000) */
  discountPercent: integer("discount_percent").notNull(),
  category: text("category", { enum: CATEGORIES }),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type PricingRule = typeof pricingRules.$inferSelect;
