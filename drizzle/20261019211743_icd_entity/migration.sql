CREATE TABLE `icd_entity` (
	`release` text NOT NULL,
	`code` text NOT NULL,
	`lang` text NOT NULL,
	`title` text NOT NULL,
	CONSTRAINT `icd_entity_pk` PRIMARY KEY(`release`, `code`, `lang`)
);
