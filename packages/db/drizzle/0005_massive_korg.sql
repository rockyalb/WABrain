CREATE TABLE "notification_deliveries" (
	"event_id" text NOT NULL,
	"device_id" text NOT NULL,
	"pushed_at" timestamp (3) with time zone,
	"acknowledged_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_event_id_device_id_pk" PRIMARY KEY("event_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"dedup_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"task_id" text,
	"review_item_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "notification_events_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD COLUMN "profile_cursor_created_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD COLUMN "profile_cursor_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD COLUMN "profile_target_created_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD COLUMN "profile_target_message_id" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_review_item_id_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."review_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_pending_idx" ON "notification_deliveries" USING btree ("next_attempt_at");