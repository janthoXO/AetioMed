CREATE TABLE `job_record` (
	`job_id` text PRIMARY KEY,
	`transport` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`updated_at` integer NOT NULL,
	`data` text NOT NULL,
	`encrypted_api_key` text
);
--> statement-breakpoint
CREATE INDEX `idx_job_record_transport` ON `job_record` (`transport`);--> statement-breakpoint
CREATE INDEX `idx_job_record_expires_at` ON `job_record` (`expires_at`);