ALTER TABLE `invoices` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `voided_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `invoices` ADD `voided_by_name` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `replaces_invoice_id` integer REFERENCES invoices(id);--> statement-breakpoint
CREATE INDEX `invoices_replaces_idx` ON `invoices` (`replaces_invoice_id`);--> statement-breakpoint
ALTER TABLE `payments` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `payments` ADD `voided_by_name` text;