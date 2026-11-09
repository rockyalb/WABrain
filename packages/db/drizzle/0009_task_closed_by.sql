ALTER TABLE "tasks" ADD COLUMN "closed_by" text;--> statement-breakpoint
-- Recover the actor of the current closure, rather than the task's creation origin.
-- Prefer the original closure when an undo restored it; leave unknown history null.
WITH closures AS (
  SELECT DISTINCT ON (t.id) t.id, e.actor
  FROM tasks t
  JOIN task_events e ON e.task_id = t.id
  WHERE t.status IN ('done', 'cancelled')
    AND e.undone_at IS NULL
    AND e.type IN ('completed', 'cancelled', 'undone')
    AND e.after->>'status' = t.status
    AND (e.after->>'closedAt')::timestamptz = t.closed_at
  ORDER BY t.id, CASE WHEN e.type = 'undone' THEN 1 ELSE 0 END, e.created_at DESC, e.id DESC
)
UPDATE tasks t SET closed_by = c.actor FROM closures c WHERE t.id = c.id;
