CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`batch_number` text NOT NULL,
	`mfg_date` text,
	`expiry_date` text,
	`purchase_price` integer NOT NULL,
	`mrp` integer NOT NULL,
	`selling_price` integer NOT NULL,
	`quantity_available` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "batches_qty_chk" CHECK("batches"."quantity_available" >= 0),
	CONSTRAINT "batches_price_chk" CHECK("batches"."purchase_price" >= 0 and "batches"."mrp" >= 0 and "batches"."selling_price" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_product_batch_uq` ON `batches` (`product_id`,`batch_number`);--> statement-breakpoint
CREATE INDEX `batches_fefo_idx` ON `batches` (`product_id`,`expiry_date`);--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`batch_number` text NOT NULL,
	`unit_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`purchase_price` integer NOT NULL,
	`discount_type` text DEFAULT 'none' NOT NULL,
	`discount_value` integer DEFAULT 0 NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`gst_rate` integer NOT NULL,
	`taxable_amount` integer NOT NULL,
	`tax_amount` integer NOT NULL,
	`line_total` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invoice_items_qty_chk" CHECK("invoice_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_idx` ON `invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_number` text NOT NULL,
	`customer_name` text,
	`customer_phone` text,
	`subtotal` integer NOT NULL,
	`discount_total` integer NOT NULL,
	`tax_total` integer NOT NULL,
	`round_off` integer DEFAULT 0 NOT NULL,
	`grand_total` integer NOT NULL,
	`payment_mode` text NOT NULL,
	`cash_amount` integer DEFAULT 0 NOT NULL,
	`upi_amount` integer DEFAULT 0 NOT NULL,
	`card_amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_uq` ON `invoices` (`invoice_number`);--> statement-breakpoint
CREATE INDEX `invoices_created_idx` ON `invoices` (`created_at`);--> statement-breakpoint
CREATE TABLE `pricing_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`min_days_to_expiry` integer DEFAULT 0 NOT NULL,
	`max_days_to_expiry` integer NOT NULL,
	`discount_percent` integer NOT NULL,
	`category` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sku` text NOT NULL,
	`barcode` text,
	`category` text NOT NULL,
	`unit_type` text NOT NULL,
	`allow_decimal_qty` integer DEFAULT false NOT NULL,
	`low_stock_threshold` integer DEFAULT 0 NOT NULL,
	`gst_rate` integer DEFAULT 0 NOT NULL,
	`hsn_code` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	CONSTRAINT "products_gst_chk" CHECK("products"."gst_rate" in (0,5,12,18)),
	CONSTRAINT "products_threshold_chk" CHECK("products"."low_stock_threshold" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_uq` ON `products` (`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_barcode_uq` ON `products` (`barcode`);--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`type` text NOT NULL,
	`quantity_delta` integer NOT NULL,
	`reference_type` text,
	`reference_id` integer,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `movements_batch_idx` ON `stock_movements` (`batch_id`);--> statement-breakpoint
CREATE INDEX `movements_created_idx` ON `stock_movements` (`created_at`);