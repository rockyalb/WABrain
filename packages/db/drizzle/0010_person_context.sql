ALTER TABLE "people" ADD COLUMN "context_confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- A direct chat's context belongs to its person. Where the person has none yet, adopt their direct
-- chat's (an owner-confirmed one first, then the most recently active); the person's own wins.
WITH adopted AS (
  SELECT DISTINCT ON (c.person_id) c.person_id, c.default_context_id, c.context_confirmed
  FROM chats c
  WHERE NOT c.is_group AND c.person_id IS NOT NULL AND c.default_context_id IS NOT NULL
  ORDER BY c.person_id, c.context_confirmed DESC, c.last_message_at DESC NULLS LAST, c.id
)
UPDATE people p
SET default_context_id = a.default_context_id, context_confirmed = a.context_confirmed, updated_at = now()
FROM adopted a
WHERE p.id = a.person_id AND p.default_context_id IS NULL;
--> statement-breakpoint
-- A direct chat with a person always carries the person's context and confirmation.
CREATE OR REPLACE FUNCTION wabrain_chat_context_from_person() RETURNS trigger AS $$
BEGIN
  IF NOT NEW.is_group AND NEW.person_id IS NOT NULL THEN
    SELECT p.default_context_id, p.context_confirmed INTO NEW.default_context_id, NEW.context_confirmed
    FROM people p WHERE p.id = NEW.person_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wabrain_person_context_to_chats() RETURNS trigger AS $$
BEGIN
  UPDATE chats SET default_context_id = NEW.default_context_id, context_confirmed = NEW.context_confirmed, updated_at = now()
  WHERE person_id = NEW.id AND NOT is_group
    AND (default_context_id IS DISTINCT FROM NEW.default_context_id OR context_confirmed IS DISTINCT FROM NEW.context_confirmed);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER chats_context_from_person BEFORE INSERT OR UPDATE OF is_group, person_id, default_context_id, context_confirmed ON chats FOR EACH ROW EXECUTE FUNCTION wabrain_chat_context_from_person();
--> statement-breakpoint
CREATE TRIGGER people_context_to_chats AFTER UPDATE OF default_context_id, context_confirmed ON people FOR EACH ROW EXECUTE FUNCTION wabrain_person_context_to_chats();
--> statement-breakpoint
-- Bring existing direct chats in line with their person.
UPDATE chats c SET default_context_id = p.default_context_id, context_confirmed = p.context_confirmed, updated_at = now()
FROM people p
WHERE c.person_id = p.id AND NOT c.is_group
  AND (c.default_context_id IS DISTINCT FROM p.default_context_id OR c.context_confirmed IS DISTINCT FROM p.context_confirmed);
