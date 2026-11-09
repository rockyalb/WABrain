ALTER TABLE "tasks" ADD COLUMN "created_by" text;--> statement-breakpoint
-- Recover who created each task from its "created" event: an AI task the owner accepted in Review
-- was created by the owner. Manual tasks are the owner's even without history; leave the rest null.
UPDATE tasks t SET created_by = COALESCE(
  (SELECT e.actor FROM task_events e WHERE e.task_id = t.id AND e.type = 'created' ORDER BY e.created_at, e.id LIMIT 1),
  CASE WHEN t.origin = 'manual' THEN 'owner' END
);
