/**
 * Reads a PDF for the media job: extracts each page's text layer and, when that is missing or
 * unusable, renders the pages to grayscale PNG images for the vision model.
 *
 * Renderer: PDFium compiled to WebAssembly (`@hyzyla/pdfium`, MIT wrapper; PDFium itself is
 * BSD/Apache). It needs no native module and no system package in the Docker image, and this build
 * has no JavaScript engine (no V8, no XFA), so PDF scripts and form actions can never run. Forms are
 * not initialized, so only page content and annotation appearances are drawn.
 *
 * The PDF is untrusted, so it is parsed in a separate worker thread per document:
 * - a hard deadline (`timeoutMs`) terminates the thread even inside a synchronous WASM call, which a
 *   timer in this thread could not interrupt;
 * - the thread gets no environment variables, a capped JS heap, and its output is discarded;
 * - only the first `maxPages` pages are loaded, each render is scaled to at most `maxPagePixels`,
 *   and rendering stops at `maxTotalPixels` or `maxImageBytes` of PNG output;
 * - encrypted, broken, and empty PDFs end in a `PdfError` with a stable reason, never a retry loop.
 * The copy of the PDF handed to the thread and the thread's whole WASM heap are zeroed before it
 * ends; the thread is always terminated afterwards, which releases its memory.
 */
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export interface PdfLimits {
  /** Pages read (text layer and rendering) from the start of the document. */
  maxPages: number;
  /** Pixels per rendered page; pages are scaled down to fit (and never above 2x, 144 dpi). */
  maxPagePixels: number;
  /** Pixels rendered per document; later pages are dropped once this is reached. */
  maxTotalPixels: number;
  /** PNG bytes per document; later pages are dropped once this is reached. */
  maxImageBytes: number;
  /** Deadline for the whole read, after which the thread is terminated. */
  timeoutMs: number;
  /** Letters and digits a page's text layer needs to count as usable. */
  minTextChars?: number;
}

export const MIN_TEXT_LAYER_CHARS = 20;
/** Longest rendered side in pixels, whatever the page's aspect ratio. */
export const MAX_RENDER_SIDE = 4096;
/** Heap cap for the parsing thread (the WASM heap is bounded by the pixel limits and the deadline). */
const WORKER_HEAP_MB = 256;

export type PdfFailure =
  /** Password protected or an unsupported security handler. */
  | "pdf_encrypted"
  /** Not a PDF, or too damaged to open. */
  | "invalid_pdf"
  /** A document without pages, or none that could be rendered. */
  | "pdf_empty"
  /** The read did not finish within `timeoutMs`. */
  | "pdf_timeout"
  /** The parser crashed or ran out of memory on this document. */
  | "pdf_render_error";

/** A permanent problem with this PDF (the same bytes would fail again). */
export class PdfError extends Error {
  constructor(
    readonly reason: PdfFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "PdfError";
  }
}

export interface PdfPageText {
  /** 1-based page number in the document. */
  page: number;
  text: string;
}

export interface PdfPageImage {
  /** 1-based page number in the document. */
  page: number;
  bytes: Uint8Array;
  mimeType: "image/png";
  width: number;
  height: number;
}

export type PdfReadResult =
  /** Every page read had a usable text layer; nothing was rendered. */
  | { mode: "text"; pageCount: number; pages: PdfPageText[] }
  /** Pages rendered for the vision model, in document order (possibly fewer than `maxPages`). */
  | { mode: "images"; pageCount: number; pagesRead: number; images: PdfPageImage[] };

/** Returns true when the bytes carry a PDF header (within the first KiB, as readers accept). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).includes("%PDF-");
}

/**
 * Normalizes a page's text layer and returns it when it is usable: enough letters or digits, and
 * not mostly replacement or private-use characters (a sign of fonts without a Unicode mapping, which
 * extract as gibberish). Returns null otherwise, which makes the document go to the vision model.
 */
export function usableText(raw: string, minChars = MIN_TEXT_LAYER_CHARS): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u00ad\ufeff]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const meaningful = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const garbled = text.match(/[\ufffd\p{Co}]/gu)?.length ?? 0;
  if (meaningful < minChars || garbled > (meaningful + garbled) * 0.1) return null;
  return text;
}

type WorkerMessage =
  | { type: "opened"; pageCount: number; texts: string[] }
  | { type: "closed" }
  | { type: "rendered"; images: Array<{ page: number; width: number; height: number; png: ArrayBuffer }> }
  | { type: "error"; stage: "init" | "load" | "read"; message: string };

let pdfiumEntry: string | null = null;
/** Resolved lazily, so a missing renderer only affects PDFs; the thread loads it by absolute path. */
function resolvePdfium(): string {
  pdfiumEntry ??= createRequire(import.meta.url).resolve("@hyzyla/pdfium");
  return pdfiumEntry;
}

function loadFailure(message: string): PdfError {
  if (/password|security/i.test(message)) return new PdfError("pdf_encrypted");
  return new PdfError("invalid_pdf", message.slice(0, 80));
}

/**
 * Reads the PDF in a fresh worker thread. The caller keeps (and zeroes) `bytes`; the thread works on
 * its own copy. Rendered images belong to the caller, who should zero them after use.
 */
export async function readPdf(bytes: Uint8Array, limits: PdfLimits): Promise<PdfReadResult> {
  const entry = resolvePdfium();
  const copy = new Uint8Array(bytes); // transferred to the thread, which zeroes it after loading
  const minChars = limits.minTextChars ?? MIN_TEXT_LAYER_CHARS;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      entry,
      pdf: copy.buffer,
      limits: {
        maxPages: Math.max(1, Math.floor(limits.maxPages)),
        maxPagePixels: Math.max(1, Math.floor(limits.maxPagePixels)),
        maxTotalPixels: Math.max(1, Math.floor(limits.maxTotalPixels)),
        maxImageBytes: Math.max(1, Math.floor(limits.maxImageBytes)),
        maxSide: MAX_RENDER_SIDE,
      },
    },
    transferList: [copy.buffer],
    env: {},
    execArgv: [],
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 32 },
  });
  worker.stdout.resume();
  worker.stderr.resume();

  const messages: WorkerMessage[] = [];
  let waiting: { resolve: (message: WorkerMessage) => void; reject: (error: Error) => void } | null = null;
  let failure: Error | null = null;
  const fail = (error: Error) => {
    failure ??= error;
    waiting?.reject(failure);
    waiting = null;
  };
  worker.on("message", (message: WorkerMessage) => {
    if (waiting) {
      waiting.resolve(message);
      waiting = null;
    } else messages.push(message);
  });
  worker.on("error", (error: Error & { code?: string }) => {
    fail(new PdfError("pdf_render_error", error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : undefined));
  });
  worker.on("exit", () => fail(new PdfError("pdf_render_error", "exited")));
  const timer = setTimeout(() => fail(new PdfError("pdf_timeout")), Math.max(1, limits.timeoutMs));
  const next = () =>
    new Promise<WorkerMessage>((resolve, reject) => {
      const queued = messages.shift();
      if (queued) resolve(queued);
      else if (failure) reject(failure);
      else waiting = { resolve, reject };
    });

  try {
    const opened = await next();
    if (opened.type === "error") {
      // A renderer that cannot start is a deployment problem, not this document's: let the job retry.
      if (opened.stage === "init") throw new Error(`pdf_renderer_unavailable: ${opened.message}`);
      if (opened.stage === "load") throw loadFailure(opened.message);
      throw new PdfError("pdf_render_error", opened.message.slice(0, 80));
    }
    if (opened.type !== "opened") throw new PdfError("pdf_render_error", "protocol");
    if (opened.pageCount <= 0) throw new PdfError("pdf_empty");

    const texts = opened.texts.map((text) => usableText(text, minChars));
    if (texts.length > 0 && texts.every((text) => text !== null)) {
      // Let the thread zero its heap before it is terminated (best effort within the deadline).
      worker.postMessage({ type: "close" });
      await next().catch(() => {});
      return { mode: "text", pageCount: opened.pageCount, pages: texts.map((text, index) => ({ page: index + 1, text: text! })) };
    }

    worker.postMessage({ type: "render" });
    const rendered = await next();
    if (rendered.type === "error") throw new PdfError("pdf_render_error", rendered.message.slice(0, 80));
    if (rendered.type !== "rendered") throw new PdfError("pdf_render_error", "protocol");
    const images = rendered.images.map((image) => ({
      page: image.page,
      bytes: new Uint8Array(image.png),
      mimeType: "image/png" as const,
      width: image.width,
      height: image.height,
    }));
    if (images.length === 0) throw new PdfError("pdf_empty", "no_renderable_pages");
    return { mode: "images", pageCount: opened.pageCount, pagesRead: opened.texts.length, images };
  } finally {
    clearTimeout(timer);
    worker.removeAllListeners("exit");
    worker.on("error", () => {});
    await worker.terminate().catch(() => {});
  }
}

/**
 * The thread's code (CommonJS, evaluated as is so it works unchanged from sources, tests, and the
 * bundled worker image). It loads PDFium by the absolute path resolved in the parent.
 */
const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const zlib = require("node:zlib");

const limits = workerData.limits;
const pdf = new Uint8Array(workerData.pdf);
let lib = null;
let doc = null;
let pages = [];

const post = (message, transfer) => parentPort.postMessage(message, transfer || []);
const messageOf = (error) => String((error && error.message) || error).replace(/\s+/g, " ").slice(0, 200);
function wipe() {
  pdf.fill(0);
  try { if (lib && lib.module && lib.module.HEAPU8) lib.module.HEAPU8.fill(0); } catch {}
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + data.length);
  return out;
}
/** 8-bit grayscale PNG, filter 0 on every row. */
function encodeGrayPng(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  raw.fill(0);
  const own = new Uint8Array(png); // its own ArrayBuffer, so it can be transferred
  png.fill(0);
  return own;
}

function renderSize(page) {
  const size = page.getOriginalSize();
  const w = size.originalWidth, h = size.originalHeight;
  if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const scale = Math.min(2, Math.sqrt(limits.maxPagePixels / (w * h)), limits.maxSide / w, limits.maxSide / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

async function render() {
  const images = [];
  const transfer = [];
  let totalPixels = 0;
  let totalBytes = 0;
  for (const entry of pages) {
    if (!entry.page) continue;
    const size = renderSize(entry.page);
    if (!size) continue;
    if (totalPixels + size.width * size.height > limits.maxTotalPixels) break;
    const bitmap = await entry.page.render({ width: size.width, height: size.height, scale: 1, colorSpace: "Gray", render: "bitmap" });
    entry.page = null; // render() closes the page
    const png = encodeGrayPng(bitmap.width, bitmap.height, bitmap.data);
    bitmap.data.fill(0);
    if (totalBytes + png.byteLength > limits.maxImageBytes) {
      png.fill(0);
      break;
    }
    totalPixels += bitmap.width * bitmap.height;
    totalBytes += png.byteLength;
    images.push({ page: entry.number, width: bitmap.width, height: bitmap.height, png: png.buffer });
    transfer.push(png.buffer);
  }
  return { images, transfer };
}

(async () => {
  try {
    const { PDFiumLibrary } = require(workerData.entry);
    lib = await PDFiumLibrary.init();
  } catch (error) {
    wipe();
    post({ type: "error", stage: "init", message: messageOf(error) });
    return;
  }
  try {
    doc = await lib.loadDocument(pdf);
  } catch (error) {
    wipe();
    post({ type: "error", stage: "load", message: messageOf(error) });
    return;
  } finally {
    pdf.fill(0); // PDFium keeps its own copy in the WASM heap
  }
  try {
    const pageCount = doc.getPageCount();
    const texts = [];
    for (let i = 0; i < Math.min(pageCount, limits.maxPages); i++) {
      const page = doc.getPage(i);
      let text = "";
      if (page.pageIdx) {
        try { text = page.getText(); } catch { text = ""; }
      }
      pages.push({ number: i + 1, page: page.pageIdx ? page : null });
      texts.push(text);
    }
    post({ type: "opened", pageCount, texts });
  } catch (error) {
    wipe();
    post({ type: "error", stage: "read", message: messageOf(error) });
    return;
  }
  parentPort.once("message", async (message) => {
    if (!message || message.type !== "render") {
      wipe();
      post({ type: "closed" });
      return;
    }
    try {
      const { images, transfer } = await render();
      wipe();
      post({ type: "rendered", images }, transfer);
    } catch (error) {
      wipe();
      post({ type: "error", stage: "read", message: messageOf(error) });
    }
  });
})();
`;
