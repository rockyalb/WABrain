-- Sync versions, tombstones, and immutability guarantees.
--
-- Every insert/update of a syncable row takes a new value from
-- sync_version_seq. Writers hold a transaction-scoped *shared* advisory lock
-- (key 727001) while they hold unpublished versions; the sync reader briefly
-- takes the *exclusive* lock to learn a high-water mark below which every
-- version is committed (see src/repos/sync.ts). Deletes leave a tombstone.

CREATE OR REPLACE FUNCTION wabrain_bump_sync_version() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(727001);
  NEW.sync_version := nextval('sync_version_seq');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wabrain_sync_tombstone() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(727001);
  INSERT INTO sync_tombstones (entity, entity_id, sync_version)
  VALUES (TG_ARGV[0], OLD.id, nextval('sync_version_seq'));
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wabrain_touch_person() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE people SET updated_at = now() WHERE id = OLD.person_id;
    RETURN OLD;
  END IF;
  UPDATE people SET updated_at = now() WHERE id = NEW.person_id;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION wabrain_source_events_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.raw IS DISTINCT FROM OLD.raw
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.chat_jid IS DISTINCT FROM OLD.chat_jid THEN
    RAISE EXCEPTION 'source_events are immutable';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER contexts_sync_version BEFORE INSERT OR UPDATE ON contexts FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER chats_sync_version BEFORE INSERT OR UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER people_sync_version BEFORE INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER tasks_sync_version BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER review_items_sync_version BEFORE INSERT OR UPDATE ON review_items FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER settings_sync_version BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION wabrain_bump_sync_version();
--> statement-breakpoint
CREATE TRIGGER contexts_tombstone AFTER DELETE ON contexts FOR EACH ROW EXECUTE FUNCTION wabrain_sync_tombstone('contexts');
--> statement-breakpoint
CREATE TRIGGER chats_tombstone AFTER DELETE ON chats FOR EACH ROW EXECUTE FUNCTION wabrain_sync_tombstone('chats');
--> statement-breakpoint
CREATE TRIGGER people_tombstone AFTER DELETE ON people FOR EACH ROW EXECUTE FUNCTION wabrain_sync_tombstone('people');
--> statement-breakpoint
CREATE TRIGGER tasks_tombstone AFTER DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION wabrain_sync_tombstone('tasks');
--> statement-breakpoint
CREATE TRIGGER review_items_tombstone AFTER DELETE ON review_items FOR EACH ROW EXECUTE FUNCTION wabrain_sync_tombstone('reviewItems');
--> statement-breakpoint
CREATE TRIGGER person_facts_touch_person AFTER INSERT OR UPDATE OR DELETE ON person_facts FOR EACH ROW EXECUTE FUNCTION wabrain_touch_person();
--> statement-breakpoint
CREATE TRIGGER source_events_immutable BEFORE UPDATE ON source_events FOR EACH ROW EXECUTE FUNCTION wabrain_source_events_immutable();
