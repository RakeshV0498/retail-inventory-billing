CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_uq` ON `customers` (`phone`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`customer_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`mode` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_chk" CHECK("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE INDEX `payments_customer_idx` ON `payments` (`customer_id`);--> statement-breakpoint
CREATE INDEX `payments_created_idx` ON `payments` (`created_at`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `credit_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `customer_id` integer REFERENCES customers(id);--> statement-breakpoint
CREATE INDEX `invoices_customer_idx` ON `invoices` (`customer_id`);