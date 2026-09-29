-- Extensions must exist before the vector column and trigram index below.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SEQUENCE "public"."sync_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"input_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_message_at" timestamp (3) with time zone,
	"to_message_at" timestamp (3) with time zone,
	"usage" jsonb,
	"latency_ms" integer,
	"actions" jsonb,
	"decisions" jsonb,
	"error" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" text PRIMARY KEY NOT NULL,
	"jid" text NOT NULL,
	"name" text,
	"is_group" boolean NOT NULL,
	"mode" text NOT NULL,
	"default_context_id" text,
	"context_confirmed" boolean DEFAULT false NOT NULL,
	"auto_create" boolean DEFAULT true NOT NULL,
	"minimum_auto_confidence" real,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"person_id" text,
	"last_message_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_examples" (
	"id" text PRIMARY KEY NOT NULL,
	"review_item_id" text,
	"review_type" text NOT NULL,
	"decision" text NOT NULL,
	"action" jsonb NOT NULL,
	"final_action" jsonb,
	"edits" jsonb,
	"reason" text NOT NULL,
	"confidence" real,
	"chat_id" text,
	"analysis_run_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope_hash" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"kind" text NOT NULL,
	"mimetype" text,
	"filename" text,
	"size_bytes" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"derived_text" text,
	"error" text,
	"raw_deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"from_at" timestamp (3) with time zone NOT NULL,
	"to_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"wa_message_id" text NOT NULL,
	"source_event_id" text,
	"participant_id" text,
	"sender_jid" text NOT NULL,
	"sender_name" text,
	"direction" text NOT NULL,
	"from_owner" boolean NOT NULL,
	"kind" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"derived_text" text,
	"language" text,
	"quoted_wa_message_id" text,
	"quoted_message_id" text,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"has_media" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"sent_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_single_row" CHECK ("owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "owner_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"device_id" text
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"jid" text NOT NULL,
	"display_name" text,
	"person_id" text,
	"last_seen_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"display_name_source" text DEFAULT 'auto' NOT NULL,
	"primary_jid" text,
	"jids" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_context_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"confidence" real NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"self_claimed" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp (3) with time zone,
	"last_failure_at" timestamp (3) with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"task_id" text,
	"action" jsonb NOT NULL,
	"reason" text NOT NULL,
	"chat_id" text,
	"person_id" text,
	"summary" text NOT NULL,
	"analysis_run_id" text,
	"result_task_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp (3) with time zone,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"end_of_work_day" text DEFAULT '17:00' NOT NULL,
	"daily_summary_time" text DEFAULT '08:00',
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"reminder_lead_minutes" integer DEFAULT 60 NOT NULL,
	"trial_started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"trial_days" integer DEFAULT 7 NOT NULL,
	"auto_create_threshold" real DEFAULT 0.85 NOT NULL,
	"sync_reset_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL,
	CONSTRAINT "settings_single_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"chat_jid" text NOT NULL,
	"raw" jsonb NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"projected_at" timestamp (3) with time zone,
	"projection_error" text
);
--> statement-breakpoint
CREATE TABLE "sync_tombstones" (
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL,
	"deleted_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"group_id" text NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"evidence_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"undoable_until" timestamp (3) with time zone,
	"undone_at" timestamp (3) with time zone,
	"review_item_id" text,
	"analysis_run_id" text,
	"confidence" real,
	"policy_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"due_at" timestamp (3) with time zone,
	"due_has_time" boolean DEFAULT false NOT NULL,
	"context_id" text,
	"chat_id" text,
	"person_id" text,
	"origin" text NOT NULL,
	"language" text,
	"confidence" real,
	"evidence_message_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"merged_into_task_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp (3) with time zone,
	"sync_version" bigint DEFAULT nextval('sync_version_seq') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_default_context_id_contexts_id_fk" FOREIGN KEY ("default_context_id") REFERENCES "public"."contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_examples" ADD CONSTRAINT "eval_examples_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD CONSTRAINT "message_chunks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_source_event_id_source_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."source_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_default_context_id_contexts_id_fk" FOREIGN KEY ("default_context_id") REFERENCES "public"."contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_facts" ADD CONSTRAINT "person_facts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_endpoints" ADD CONSTRAINT "push_endpoints_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_analysis_run_id_analysis_runs_id_fk" FOREIGN KEY ("analysis_run_id") REFERENCES "public"."analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_context_id_contexts_id_fk" FOREIGN KEY ("context_id") REFERENCES "public"."contexts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_runs_chat_idx" ON "analysis_runs" USING btree ("chat_id","started_at");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_jid_uq" ON "chats" USING btree ("jid");--> statement-breakpoint
CREATE INDEX "chats_person_idx" ON "chats" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_uq" ON "devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_message_uq" ON "media_objects" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_chunks_chat_idx" ON "message_chunks" USING btree ("chat_id","from_at");--> statement-breakpoint
CREATE INDEX "message_chunks_embedding_hnsw" ON "message_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "message_chunks_text_trgm" ON "message_chunks" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_wa_uq" ON "messages" USING btree ("chat_id","wa_message_id");--> statement-breakpoint
CREATE INDEX "messages_chat_sent_idx" ON "messages" USING btree ("chat_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_chat_jid_uq" ON "participants" USING btree ("chat_id","jid");--> statement-breakpoint
CREATE UNIQUE INDEX "people_primary_jid_uq" ON "people" USING btree ("primary_jid");--> statement-breakpoint
CREATE INDEX "people_jids_gin" ON "people" USING gin ("jids");--> statement-breakpoint
CREATE INDEX "person_facts_person_idx" ON "person_facts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoints_device_uq" ON "push_endpoints" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "review_items_state_idx" ON "review_items" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "review_items_sync_idx" ON "review_items" USING btree ("sync_version");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_session_idem_uq" ON "source_events" USING btree ("session_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "source_events_chat_jid_idx" ON "source_events" USING btree ("chat_jid");--> statement-breakpoint
CREATE INDEX "source_events_unprojected_idx" ON "source_events" USING btree ("received_at") WHERE "source_events"."projected_at" is null;--> statement-breakpoint
CREATE INDEX "sync_tombstones_version_idx" ON "sync_tombstones" USING btree ("sync_version");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_events_group_idx" ON "task_events" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_chat_idx" ON "tasks" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "tasks_person_idx" ON "tasks" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "tasks_sync_idx" ON "tasks" USING btree ("sync_version");