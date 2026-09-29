-- Chunks are derived data that the embed-chat job rebuilds; nothing filled them before this migration.
DELETE FROM "message_chunks";--> statement-breakpoint
DROP INDEX "message_chunks_text_trgm";--> statement-breakpoint
ALTER TABLE "chat_pipeline_state" ADD COLUMN "last_embedded_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "message_chunks" ADD COLUMN "embedded_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "message_chunks_chat_hash_uq" ON "message_chunks" USING btree ("chat_id","content_hash");--> statement-breakpoint
CREATE INDEX "message_chunks_search_trgm" ON "message_chunks" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "messages_chat_created_idx" ON "messages" USING btree ("chat_id","created_at");