/**
 * Explicit, opt-in backfill for PDFs recorded before PDF support (T10): those media objects were
 * finished as `skipped` with the reason `pdf_deferred_phase2`, and nothing re-queues them on its own.
 * Nothing calls this automatically; an operator runs it once. It only touches rows in exactly that
 * state, and it is idempotent: re-running it (also after a crash between the update and the enqueue)
 * returns the same rows until the media job has processed them.
 */
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { mediaObjects } from "../schema.js";

/** Reason recorded before T10 for documents that were left for "phase 2". */
export const LEGACY_PDF_SKIP_REASON = "pdf_deferred_phase2";
/** Marker on rows this backfill moved back to pending (overwritten when the media job finishes them). */
export const LEGACY_PDF_REQUEUE_MARKER = "pdf_backfill_requeued";

/**
 * Moves pre-T10 skipped PDFs back to pending (attempts reset) and returns every media object this
 * backfill has marked that is still pending, for the caller to queue `process-media` for each.
 */
export async function markLegacyPdfsForRequeue(db: Db, limit = 10_000): Promise<string[]> {
  await db
    .update(mediaObjects)
    .set({ status: "pending", error: LEGACY_PDF_REQUEUE_MARKER, attempts: 0, updatedAt: sql`now()` })
    .where(and(eq(mediaObjects.kind, "document"), eq(mediaObjects.status, "skipped"), eq(mediaObjects.error, LEGACY_PDF_SKIP_REASON)));
  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(and(eq(mediaObjects.status, "pending"), eq(mediaObjects.error, LEGACY_PDF_REQUEUE_MARKER)))
    .orderBy(asc(mediaObjects.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Reason the media job records when OpenWA has no stored file for the message. */
export const MEDIA_NOT_FOUND_REASON = "not_found";
/** Marker on rows moved back to pending by markUnavailableMediaForRequeue. */
export const MEDIA_REQUEUE_MARKER = "media_requeued";

/**
 * Moves media that failed because OpenWA had no stored file (`failed` / `not_found`) back to pending
 * (attempts reset), for after OpenWA gained a way to fetch it (history media on request). Returns
 * every media object so marked that is still pending, for the caller to queue `process-media` for
 * each. Idempotent like markLegacyPdfsForRequeue.
 */
export async function markUnavailableMediaForRequeue(db: Db, limit = 10_000): Promise<string[]> {
  await db
    .update(mediaObjects)
    .set({ status: "pending", error: MEDIA_REQUEUE_MARKER, attempts: 0, updatedAt: sql`now()` })
    .where(and(eq(mediaObjects.status, "failed"), eq(mediaObjects.error, MEDIA_NOT_FOUND_REASON)));
  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(and(eq(mediaObjects.status, "pending"), eq(mediaObjects.error, MEDIA_REQUEUE_MARKER)))
    .orderBy(asc(mediaObjects.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Prefix of the reason the media job records when a media object used up its attempts. */
export const MEDIA_RETRIES_EXHAUSTED_PREFIX = "retries_exhausted:";
/** Marker on voice notes moved back to pending by markExhaustedVoiceForRequeue. */
export const VOICE_REQUEUE_MARKER = "voice_requeued";

/**
 * Moves voice notes and audio that failed after using up their attempts (`failed` /
 * `retries_exhausted:*`, e.g. a transcription model that rejected the language hint) back to pending
 * (attempts reset). Returns every media object so marked that is still pending, for the caller to
 * queue `process-media` for each. Idempotent like markLegacyPdfsForRequeue.
 */
export async function markExhaustedVoiceForRequeue(db: Db, limit = 10_000): Promise<string[]> {
  await db
    .update(mediaObjects)
    .set({ status: "pending", error: VOICE_REQUEUE_MARKER, attempts: 0, updatedAt: sql`now()` })
    .where(
      and(
        inArray(mediaObjects.kind, ["voice", "audio"]),
        eq(mediaObjects.status, "failed"),
        like(mediaObjects.error, `${MEDIA_RETRIES_EXHAUSTED_PREFIX}%`),
      ),
    );
  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(and(eq(mediaObjects.status, "pending"), eq(mediaObjects.error, VOICE_REQUEUE_MARKER)))
    .orderBy(asc(mediaObjects.createdAt))
    .limit(limit);
  return rows.map((row) => row.id);
}
