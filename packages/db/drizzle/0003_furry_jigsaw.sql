CREATE TABLE "history_import_gaps" (
	"session_id" text NOT NULL,
	"cursor" text NOT NULL,
	"chat_jid" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "history_import_gaps_session_id_cursor_reason_pk" PRIMARY KEY("session_id","cursor","reason")
);
--> statement-breakpoint
CREATE TABLE "history_import_runs" (
	"session_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"days" integer NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"cutoff_at" timestamp (3) with time zone NOT NULL,
	"after_cursor" text,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"total_estimate" integer,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "history_import_gaps" ADD CONSTRAINT "history_import_gaps_session_id_history_import_runs_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."history_import_runs"("session_id") ON DELETE cascade ON UPDATE no action;