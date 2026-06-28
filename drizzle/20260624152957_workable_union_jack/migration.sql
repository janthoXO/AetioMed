CREATE TABLE `diagnosis` (
	`icd` text PRIMARY KEY,
	`name` text NOT NULL,
	`alternative_names` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_meta` (
	`source` text PRIMARY KEY,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `predefined_item` (
	`source` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `predefined_item_pk` PRIMARY KEY(`source`, `position`)
);
--> statement-breakpoint
CREATE TABLE `translation` (
	`domain` text NOT NULL,
	`lang` text NOT NULL,
	`english` text NOT NULL,
	`translated` text NOT NULL,
	CONSTRAINT `translation_pk` PRIMARY KEY(`domain`, `lang`, `english`)
);
--> statement-breakpoint
CREATE INDEX `idx_translation_reverse` ON `translation` (`domain`,`lang`,`translated`);