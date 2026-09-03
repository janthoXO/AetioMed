CREATE TABLE `symptom_cache` (
	`icd` text PRIMARY KEY,
	`symptoms` text NOT NULL,
	`updated_at` integer NOT NULL
);
