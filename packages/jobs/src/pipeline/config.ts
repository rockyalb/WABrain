/** Pipeline limits and timings, from the environment with safe defaults. */
import { z } from "zod";

const ms = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

export const PipelineConfigSchema = z.object({
  /** Quiet period before a chat is analyzed. */
  analysisDebounceMs: ms(90_000),
  /** Upper bound on how long a busy chat's analysis can be postponed. */
  analysisMaxWaitMs: ms(10 * 60_000),
  /** How long analysis waits for a burst's media jobs before analyzing without them. */
  mediaWaitMaxMs: ms(10 * 60_000),
  /** Re-check interval while waiting for media. */
  mediaRecheckMs: ms(15_000),
  /** Messages consumed per analysis run; the rest go to the next run. */
  maxBurstMessages: z.coerce.number().int().min(1).max(200).default(40),
  /** Preceding messages included as context. */
  precedingMessages: z.coerce.number().int().min(0).max(100).default(30),
  modelTimeoutMs: ms(120_000),
  mediaFetchTimeoutMs: ms(30_000),
  maxImageBytes: z.coerce.number().int().min(1).default(10 * 1024 * 1024),
  maxAudioBytes: z.coerce.number().int().min(1).default(16 * 1024 * 1024),
  maxAudioSeconds: z.coerce.number().int().min(1).default(10 * 60),
  /** PDFs larger than this are not fetched. */
  maxPdfBytes: z.coerce.number().int().min(1).default(20 * 1024 * 1024),
  /** Pages read from the start of a PDF (text layer or rendered images). */
  maxPdfPages: z.coerce.number().int().min(1).max(50).default(8),
  /** Pixels per rendered PDF page (about A4 at 144 dpi); larger pages are scaled down. */
  maxPdfPagePixels: z.coerce.number().int().min(10_000).default(2_000_000),
  /** Pixels rendered per PDF; pages past this are not sent to the vision model. */
  maxPdfTotalPixels: z.coerce.number().int().min(10_000).default(16_000_000),
  /** PNG bytes sent to the vision model per PDF; pages past this are not sent. */
  maxPdfImageBytes: z.coerce.number().int().min(1).default(12 * 1024 * 1024),
  /** Deadline for opening and rendering one PDF (its parser thread is terminated after it). */
  pdfTimeoutMs: z.coerce.number().int().min(1).default(60_000),
  maxMediaAttempts: z.coerce.number().int().min(1).max(20).default(4),
  /** Retry delay when no text provider is configured yet. */
  providerRetryMs: ms(15 * 60_000),
  /** Reminders are not sent for tasks due longer ago than this (worker downtime catch-up window). */
  reminderGraceMs: ms(60 * 60_000),
  /** The daily summary is still sent this long after its time (worker downtime catch-up window). */
  summaryWindowMs: ms(2 * 60 * 60_000),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

const ENV_NAMES: Record<keyof PipelineConfig, string> = {
  analysisDebounceMs: "ANALYSIS_DEBOUNCE_MS",
  analysisMaxWaitMs: "ANALYSIS_MAX_WAIT_MS",
  mediaWaitMaxMs: "MEDIA_WAIT_MAX_MS",
  mediaRecheckMs: "MEDIA_RECHECK_MS",
  maxBurstMessages: "ANALYSIS_MAX_BURST_MESSAGES",
  precedingMessages: "ANALYSIS_PRECEDING_MESSAGES",
  modelTimeoutMs: "MODEL_TIMEOUT_MS",
  mediaFetchTimeoutMs: "MEDIA_FETCH_TIMEOUT_MS",
  maxImageBytes: "MEDIA_MAX_IMAGE_BYTES",
  maxAudioBytes: "MEDIA_MAX_AUDIO_BYTES",
  maxAudioSeconds: "MEDIA_MAX_AUDIO_SECONDS",
  maxPdfBytes: "MEDIA_MAX_PDF_BYTES",
  maxPdfPages: "MEDIA_MAX_PDF_PAGES",
  maxPdfPagePixels: "MEDIA_MAX_PDF_PAGE_PIXELS",
  maxPdfTotalPixels: "MEDIA_MAX_PDF_TOTAL_PIXELS",
  maxPdfImageBytes: "MEDIA_MAX_PDF_IMAGE_BYTES",
  pdfTimeoutMs: "MEDIA_PDF_TIMEOUT_MS",
  maxMediaAttempts: "MEDIA_MAX_ATTEMPTS",
  providerRetryMs: "PROVIDER_RETRY_MS",
  reminderGraceMs: "REMINDER_GRACE_MS",
  summaryWindowMs: "SUMMARY_WINDOW_MS",
};

export function pipelineConfigFromEnv(env: Record<string, string | undefined>) {
  const raw = Object.fromEntries(
    Object.entries(ENV_NAMES)
      .map(([key, name]) => [key, env[name]])
      .filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = PipelineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const byKey = Object.fromEntries(Object.entries(ENV_NAMES));
    return { success: false as const, issues: parsed.error.issues.map((issue) => `${byKey[String(issue.path[0])] ?? issue.path.join(".")}: ${issue.message}`) };
  }
  return { success: true as const, config: parsed.data };
}

export const defaultPipelineConfig = (): PipelineConfig => PipelineConfigSchema.parse({});
