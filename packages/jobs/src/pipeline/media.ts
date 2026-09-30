/**
 * process-media: fetches one image, voice note, or PDF through OpenWA's read-only stored-media
 * endpoint, with limits on type, size, duration, and time; dedupes by content hash; asks the vision or
 * transcription model for derived text; and writes that text onto the message. Raw bytes only ever
 * live in a memory buffer, which is zeroed afterwards; nothing is written to disk.
 *
 * PDFs (phase 2, see ./pdf.ts): when every page read has a usable text layer, that text is stored
 * as is, with no model call (cheaper, and exact). Otherwise (scans, photos, text drawn as paths, fonts
 * without a Unicode mapping) the pages are rendered to images and described by the vision model with
 * `describePdfPages`, one call per document. Either way at most `maxPdfPages` pages are read. A PDF
 * does not wait for a vision provider or the vision budget before it is read: only when its pages
 * need the model is it skipped (no provider) or deferred to the budget reset, like an image.
 *
 * Permanent problems (too large, wrong type, not found, not configured) end in `skipped`/`failed`
 * with a reason and never block analysis. Transient problems are retried a bounded number of times.
 */
import { describeImage, describePdfPages, detectLanguage, transcribeAudio, type Providers } from "@wabrain/agent";
import {
  claimMediaObject,
  completeMediaObject,
  findProcessedMediaByHash,
  finishMediaObject,
  getMediaJobContext,
  getPersonRow,
  markExhaustedVoiceForRequeue,
  markLegacyPdfsForRequeue,
  markUnavailableMediaForRequeue,
  profileHasRead,
  recordModelUsage,
  releaseMediaObject,
  type MediaJobContext,
  type ProviderRole,
} from "@wabrain/db";
import { createHash } from "node:crypto";
import { checkBudget, recordDeferral } from "./budget.js";
import type { ProvidersState } from "../providers.js";
import type { PipelineDeps } from "./deps.js";
import { PdfError, looksLikePdf, readPdf, type PdfPageText, type PdfReadResult } from "./pdf.js";

export const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
export const AUDIO_MIME_TYPES = new Set([
  "audio/ogg",
  "audio/opus",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/3gpp",
]);

export const PDF_MIME_TYPES = new Set(["application/pdf"]);
/** Stored derived text per PDF (the analysis prompt caps it further; search indexes all of it in parts). */
export const MAX_PDF_TEXT_CHARS = 20_000;

export type MediaOutcome =
  | { status: "done"; deduped: boolean }
  | { status: "skipped" | "failed"; reason: string }
  | { status: "deferred"; until: Date }
  | { status: "missing" | "already_final" | "retry" };

/** The vision budget is used up after a PDF turned out to need the model: retry at the reset. */
class MediaDeferred extends Error {
  constructor(
    readonly role: ProviderRole,
    readonly until: Date,
  ) {
    super("budget");
  }
}

/** A permanent media problem: recorded as the final state, not retried. */
class MediaRejected extends Error {
  constructor(
    readonly status: "skipped" | "failed",
    readonly reason: string,
  ) {
    super(reason);
  }
}

const baseMime = (value: string | null | undefined) => (value ?? "").split(";")[0]!.trim().toLowerCase();

function roleFor(kind: string): ProviderRole | null {
  if (kind === "image" || kind === "document") return "vision";
  if (kind === "voice" || kind === "audio") return "transcription";
  return null;
}

function declaredDuration(raw: Record<string, unknown> | null): number | null {
  for (const key of ["seconds", "duration", "durationSeconds"]) {
    const value = raw?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** Reads a response body into memory, aborting as soon as it exceeds `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new MediaRejected("skipped", "too_large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      for (const chunk of chunks) chunk.fill(0);
      throw new MediaRejected("skipped", "too_large");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  return bytes;
}

/**
 * OpenWA may answer with the raw bytes or with a JSON envelope holding base64 data. Returns the
 * bytes and the mime type the server reported.
 */
async function fetchMedia(deps: PipelineDeps, ctx: MediaJobContext, maxBytes: number): Promise<{ bytes: Buffer; mime: string | null }> {
  const response = await deps.media!.getStoredMedia(ctx.sessionId!, ctx.chat.jid, ctx.message.waMessageId, {
    signal: AbortSignal.timeout(deps.config.mediaFetchTimeoutMs),
  });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel().catch(() => {});
    throw new MediaRejected("failed", "not_found");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new MediaRejected("failed", "openwa_forbidden");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`openwa_http_${response.status}`);
  }
  const type = baseMime(response.headers.get("content-type"));
  if (type === "application/json") {
    // base64 is 4/3 of the size, plus a little JSON.
    const text = (await readCapped(response, Math.ceil(maxBytes * 1.4) + 4096)).toString("utf8");
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      envelope = (parsed.data && typeof parsed.data === "object" ? parsed.data : parsed) as Record<string, unknown>;
    } catch {
      throw new MediaRejected("failed", "invalid_media_response");
    }
    const data = [envelope.base64, envelope.data, envelope.media, envelope.file].find((value) => typeof value === "string") as string | undefined;
    if (!data) throw new MediaRejected("failed", "invalid_media_response");
    const bytes = Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (bytes.length > maxBytes) {
      bytes.fill(0);
      throw new MediaRejected("skipped", "too_large");
    }
    const mime = [envelope.mimetype, envelope.mimeType, envelope.contentType].find((value) => typeof value === "string") as string | undefined;
    return { bytes, mime: mime ? baseMime(mime) : null };
  }
  return { bytes: await readCapped(response, maxBytes), mime: type || null };
}

function composeImageText(description: string, ocrText: string): string {
  const parts = [description.trim()];
  if (ocrText.trim()) parts.push(`Text in image: ${ocrText.trim()}`);
  return parts.filter(Boolean).join("\n");
}

/** "PDF, 12 pages (first 8 read)", the model's summary when there is one, then each page's text. */
export function composePdfText(pageCount: number, lastPageRead: number, summary: string | null, pages: readonly PdfPageText[]): string {
  const read = lastPageRead < pageCount ? ` (first ${lastPageRead} read)` : "";
  const parts = [`PDF, ${pageCount} ${pageCount === 1 ? "page" : "pages"}${read}`];
  if (summary?.trim()) parts.push(summary.trim());
  for (const page of pages) if (page.text.trim()) parts.push(`Page ${page.page}: ${page.text.trim()}`);
  const text = parts.join("\n");
  return text.length > MAX_PDF_TEXT_CHARS ? `${text.slice(0, MAX_PDF_TEXT_CHARS)}… [truncated]` : text;
}

async function analyzePdf(
  deps: PipelineDeps,
  state: ProvidersState,
  ctx: MediaJobContext,
  bytes: Buffer,
): Promise<{ text: string; language: string | null; durationSeconds: null }> {
  const { config } = deps;
  let read: PdfReadResult;
  try {
    read = await readPdf(bytes, {
      maxPages: config.maxPdfPages,
      maxPagePixels: config.maxPdfPagePixels,
      maxTotalPixels: config.maxPdfTotalPixels,
      maxImageBytes: config.maxPdfImageBytes,
      timeoutMs: config.pdfTimeoutMs,
    });
  } catch (error) {
    // Encrypted PDFs cannot be read without the password; broken or hostile ones would fail again.
    if (error instanceof PdfError) throw new MediaRejected(error.reason === "pdf_encrypted" ? "skipped" : "failed", error.reason);
    throw error;
  }
  if (read.mode === "text") {
    const allText = read.pages.map((page) => page.text).join("\n");
    return { text: composePdfText(read.pageCount, read.pages.length, null, read.pages), language: detectLanguage(allText), durationSeconds: null };
  }
  const images = read.images;
  try {
    // Only now is a vision call needed (a scan, or a page without a usable text layer).
    const providers = state.providers;
    if (!providers) throw new MediaRejected("skipped", "no_provider");
    const budget = await checkBudget(deps.database, "vision", state.limits.vision, deps.now());
    if (budget.exceeded) throw new MediaDeferred("vision", budget.resetAt);
    const result = await describePdfPages(providers, images, {
      abortSignal: AbortSignal.timeout(config.modelTimeoutMs),
      maxRetries: 1,
      maxPages: config.maxPdfPages,
    });
    if (!result) throw new MediaRejected("failed", "pdf_empty");
    await recordModelUsage(deps.database.db, {
      role: "vision",
      purpose: "pdf",
      provider: result.run.provider,
      model: result.run.modelId,
      inputTokens: result.run.inputTokens,
      outputTokens: result.run.outputTokens,
      refId: ctx.media.id,
    });
    // The model numbers the images it was given; map them back to the document's page numbers.
    const pages = result.pages.map((page) => ({ page: images[page.page - 1]!.page, text: page.text }));
    const lastPageRead = images[Math.min(images.length, result.pagesAnalyzed) - 1]!.page;
    return { text: composePdfText(read.pageCount, lastPageRead, result.summary, pages), language: result.language, durationSeconds: null };
  } finally {
    for (const image of images) image.bytes.fill(0);
  }
}

async function analyze(
  deps: PipelineDeps,
  state: ProvidersState,
  ctx: MediaJobContext,
  role: ProviderRole,
  bytes: Buffer,
  mime: string,
): Promise<{ text: string; language: string | null; durationSeconds: number | null }> {
  if (ctx.media.kind === "document") return analyzePdf(deps, state, ctx, bytes);
  const providers: Providers = state.providers!;
  const callOptions = { abortSignal: AbortSignal.timeout(deps.config.modelTimeoutMs), maxRetries: 1 };
  if (role === "vision") {
    const result = await describeImage(providers, bytes, mime, callOptions);
    await recordModelUsage(deps.database.db, {
      role,
      purpose: "image",
      provider: result.run.provider,
      model: result.run.modelId,
      inputTokens: result.run.inputTokens,
      outputTokens: result.run.outputTokens,
      refId: ctx.media.id,
    });
    return { text: composeImageText(result.description, result.ocrText), language: result.language, durationSeconds: null };
  }
  let hint: string | null = null;
  if (ctx.chat.personId) hint = (await getPersonRow(deps.database.db, ctx.chat.personId).catch(() => null))?.languages[0] ?? null;
  const result = await transcribeAudio(providers, bytes, mime, hint, callOptions);
  await recordModelUsage(deps.database.db, {
    role,
    purpose: "transcription",
    provider: result.run.provider,
    model: result.run.modelId,
    refId: ctx.media.id,
  });
  return { text: result.text, language: result.language, durationSeconds: result.durationInSeconds };
}

export async function processMedia(deps: PipelineDeps, mediaObjectId: string): Promise<MediaOutcome> {
  const { database, config } = deps;
  const ctx = await getMediaJobContext(database.db, mediaObjectId);
  if (!ctx) return { status: "missing" };
  if (ctx.media.status !== "pending" && ctx.media.status !== "processing") return { status: "already_final" };

  const reject = async (status: "skipped" | "failed", reason: string): Promise<MediaOutcome> => {
    await finishMediaObject(database.db, ctx.media.id, status, reason);
    deps.logger.info("media not analyzed", { mediaObjectId, kind: ctx.media.kind, status, reason });
    return { status, reason };
  };

  if (ctx.chat.mode === "off") return reject("skipped", "chat_off");
  const declaredMime = baseMime(ctx.media.mimetype);
  const isPdf = ctx.media.kind === "document";
  // Only PDFs among documents: by declared type, or by name when the type is missing or generic.
  // The bytes must still start like a PDF (checked after the download).
  const pdfByName = (!declaredMime || declaredMime === "application/octet-stream") && /\.pdf$/i.test(ctx.media.filename ?? "");
  if (isPdf && !(PDF_MIME_TYPES.has(declaredMime) || pdfByName)) return reject("skipped", "unsupported_document");
  const role = roleFor(ctx.media.kind);
  if (!role) return reject("skipped", "unsupported_kind");
  const allowed = isPdf ? PDF_MIME_TYPES : role === "vision" ? IMAGE_MIME_TYPES : AUDIO_MIME_TYPES;
  const maxBytes = isPdf ? config.maxPdfBytes : role === "vision" ? config.maxImageBytes : config.maxAudioBytes;
  if (!isPdf && declaredMime && !allowed.has(declaredMime)) return reject("skipped", "type_not_allowed");
  if (ctx.media.sizeBytes != null && ctx.media.sizeBytes > maxBytes) return reject("skipped", "too_large");
  const duration = declaredDuration(ctx.rawMedia);
  if (role === "transcription" && duration !== null && duration > config.maxAudioSeconds) return reject("skipped", "too_long");
  if (!deps.media) return reject("skipped", "openwa_not_configured");
  if (!ctx.sessionId) return reject("failed", "no_openwa_session");

  const deferUntil = async (deferredRole: ProviderRole, until: Date): Promise<MediaOutcome> => {
    await deps.queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId, startAfter: until });
    await recordDeferral(database, { role: deferredRole, reason: "budget", at: deps.now().toISOString(), until: until.toISOString() });
    deps.logger.warn("media deferred: daily budget reached", { mediaObjectId, role: deferredRole, until: until.toISOString() });
    return { status: "deferred", until };
  };

  const state = await deps.providers.load();
  // PDFs check the provider and budget only if their pages need the vision model (see analyzePdf).
  if (!isPdf) {
    if (!state.providers) return reject("skipped", "no_provider");
    if (role === "transcription" && !state.providers.transcription) return reject("skipped", "transcription_not_configured");
    const budget = await checkBudget(database, role, state.limits[role], deps.now());
    if (budget.exceeded) return deferUntil(role, budget.resetAt);
  }

  const claimed = await claimMediaObject(database.db, mediaObjectId);
  if (!claimed) return { status: "already_final" };
  if (claimed.attempts > config.maxMediaAttempts) return reject("failed", "too_many_attempts");

  let bytes: Buffer | null = null;
  try {
    const fetched = await fetchMedia(deps, ctx, maxBytes);
    bytes = fetched.bytes;
    // A PDF is recognized by its header, whatever type the server reports for it.
    const mime = isPdf ? "application/pdf" : fetched.mime && allowed.has(fetched.mime) ? fetched.mime : declaredMime;
    if (!mime || !allowed.has(mime)) throw new MediaRejected("skipped", "type_not_allowed");
    if (bytes.length === 0) throw new MediaRejected("failed", "empty_media");
    if (isPdf && !looksLikePdf(bytes)) throw new MediaRejected("failed", "invalid_pdf");
    const sha = createHash("sha256").update(bytes).digest("hex");

    const previous = await findProcessedMediaByHash(database.db, sha, ctx.media.id);
    const result = previous?.derivedText
      ? { text: previous.derivedText, language: previous.language, durationSeconds: previous.durationSeconds }
      : await analyze(deps, state, ctx, role, bytes, mime);
    if (role === "transcription" && result.durationSeconds && result.durationSeconds > config.maxAudioSeconds * 1.5) {
      deps.logger.warn("voice note longer than the configured limit", { mediaObjectId });
    }
    await database.transaction(({ db }) =>
      completeMediaObject(db, {
        id: ctx.media.id,
        messageId: ctx.message.id,
        derivedText: result.text,
        language: result.language,
        contentSha256: sha,
        sizeBytes: bytes!.length,
        durationSeconds: result.durationSeconds,
        setMessageLanguage: !ctx.message.body.trim(),
      }),
    );
    // Recovered after profile-chat read past the message: its text reaches the person's facts separately.
    if (result.text.trim() && ctx.chat.personId && (await profileHasRead(database.db, ctx.chat.id, { createdAt: ctx.message.createdAt, messageId: ctx.message.id }))) {
      await deps.queue.enqueue("profile-media", { mediaObjectId }, { singletonKey: mediaObjectId });
    }
    deps.logger.info("media analyzed", { mediaObjectId, kind: ctx.media.kind, deduped: Boolean(previous?.derivedText) });
    return { status: "done", deduped: Boolean(previous?.derivedText) };
  } catch (error) {
    if (error instanceof MediaDeferred) {
      // Not a failed attempt: back to pending, the attempt refunded, retried at the budget reset.
      await releaseMediaObject(database.db, ctx.media.id, "budget", { refundAttempt: true });
      return deferUntil(error.role, error.until);
    }
    if (error instanceof MediaRejected) {
      await finishMediaObject(database.db, ctx.media.id, error.status, error.reason, { rawDeleted: bytes !== null });
      deps.logger.info("media not analyzed", { mediaObjectId, kind: ctx.media.kind, status: error.status, reason: error.reason });
      return { status: error.status, reason: error.reason };
    }
    const reason = error instanceof Error ? (error.name === "Error" ? error.message : error.name) : "error";
    if (claimed.attempts >= config.maxMediaAttempts) {
      await finishMediaObject(database.db, ctx.media.id, "failed", `retries_exhausted:${reason}`.slice(0, 120));
      deps.logger.warn("media failed permanently", { mediaObjectId, reason });
      return { status: "failed", reason };
    }
    await releaseMediaObject(database.db, ctx.media.id, reason.slice(0, 120));
    throw error; // pg-boss retries with backoff.
  } finally {
    bytes?.fill(0);
  }
}

/**
 * Opt-in operator backfill: re-queues PDFs that were skipped with `pdf_deferred_phase2` before PDF
 * support existed. Idempotent (see markLegacyPdfsForRequeue); queued jobs are deduplicated per media
 * object. Returns how many media objects are queued. Nothing runs it automatically.
 */
export async function requeueLegacyPdfs(deps: Pick<PipelineDeps, "database" | "logger">, queue: Pick<PipelineDeps["queue"], "enqueue">): Promise<number> {
  const ids = await markLegacyPdfsForRequeue(deps.database.db);
  for (const mediaObjectId of ids) await queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId });
  if (ids.length) deps.logger.info("legacy PDFs re-queued", { count: ids.length });
  return ids.length;
}

/**
 * Operator command: re-queues media that failed with `not_found` (see
 * markUnavailableMediaForRequeue). Queued jobs are deduplicated per media object. Returns how many
 * media objects are queued.
 */
export async function requeueUnavailableMedia(database: Pick<PipelineDeps["database"], "db">, queue: Pick<PipelineDeps["queue"], "enqueue">): Promise<number> {
  const ids = await markUnavailableMediaForRequeue(database.db);
  for (const mediaObjectId of ids) await queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId });
  return ids.length;
}

/**
 * Operator command: re-queues voice notes and audio that used up their attempts (see
 * markExhaustedVoiceForRequeue), e.g. after a transcription fix. Ones whose chat profile already read
 * past them are profiled again when they finish (profile-media). Returns how many are queued.
 */
export async function requeueExhaustedVoice(database: Pick<PipelineDeps["database"], "db">, queue: Pick<PipelineDeps["queue"], "enqueue">): Promise<number> {
  const ids = await markExhaustedVoiceForRequeue(database.db);
  for (const mediaObjectId of ids) await queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId });
  return ids.length;
}
