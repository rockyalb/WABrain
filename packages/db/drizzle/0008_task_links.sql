ALTER TABLE "messages" ADD COLUMN "linked_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_links_gin" ON "tasks" USING gin ("links" jsonb_path_ops);