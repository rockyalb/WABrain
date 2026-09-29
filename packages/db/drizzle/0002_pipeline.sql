CREATE TABLE "app_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applied_actions" (
	"key" text PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"task_id" text,
	"review_item_id" text,
	"reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_pipeline_state" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"last_analysis_at" timestamp (3) with time zone,
	"last_analysis_run_id" text,
	"last_profile_date" text,
	"last_profile_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"role" text NOT NULL,
	"purpose" text NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"ref_id" text
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_log_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "provider_settings" (
	"role" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key_encrypted" text,
	"dimensions" integer,
	"structured_outputs" boolean,
	"daily_token_limit" integer,
	"daily_call_limit" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "dropped" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "context_reasons" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "outcomes" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "duration_seconds" real;--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "analyzable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "analysis_run_id" text;--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD CONSTRAINT "chat_pipeline_state_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_usage_role_at_idx" ON "model_usage" USING btree ("role","at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_runs_idem_uq" ON "analysis_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "media_objects_sha_idx" ON "media_objects" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "messages_unanalyzed_idx" ON "messages" USING btree ("chat_id","sent_at") WHERE "messages"."analyzable" and "messages"."analysis_run_id" is null;