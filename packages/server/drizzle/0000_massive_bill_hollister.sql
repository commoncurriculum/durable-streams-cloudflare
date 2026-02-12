CREATE TABLE `ops` (
	`start_offset` integer PRIMARY KEY NOT NULL,
	`end_offset` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`stream_seq` text,
	`producer_id` text,
	`producer_epoch` integer,
	`producer_seq` integer,
	`body` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ops_start_offset` ON `ops` (`start_offset`);--> statement-breakpoint
CREATE TABLE `producers` (
	`producer_id` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`last_offset` integer NOT NULL,
	`last_updated` integer
);
--> statement-breakpoint
CREATE TABLE `segments` (
	`read_seq` integer PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`content_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`size_bytes` integer NOT NULL,
	`message_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `segments_start_offset` ON `segments` (`start_offset`);--> statement-breakpoint
CREATE TABLE `stream_meta` (
	`stream_id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`tail_offset` integer DEFAULT 0 NOT NULL,
	`read_seq` integer DEFAULT 0 NOT NULL,
	`segment_start` integer DEFAULT 0 NOT NULL,
	`segment_messages` integer DEFAULT 0 NOT NULL,
	`segment_bytes` integer DEFAULT 0 NOT NULL,
	`last_stream_seq` text,
	`ttl_seconds` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`closed_by_producer_id` text,
	`closed_by_epoch` integer,
	`closed_by_seq` integer,
	`public` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `estuary_info` (
	`id` integer PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`estuary_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`stream_id` text PRIMARY KEY NOT NULL,
	`subscribed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fanout_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`estuary_id` text PRIMARY KEY NOT NULL,
	`subscribed_at` integer NOT NULL
);
