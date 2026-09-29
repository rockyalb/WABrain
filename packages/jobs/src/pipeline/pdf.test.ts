import { describe, expect, it } from "vitest";
import { MAX_RENDER_SIDE, PdfError, looksLikePdf, readPdf, usableText, type PdfLimits } from "./pdf.js";
import { buildPdf, decodeGrayPng } from "./test-fixtures/pdf.js";

const limits: PdfLimits = { maxPages: 8, maxPagePixels: 2_000_000, maxTotalPixels: 16_000_000, maxImageBytes: 12 * 1024 * 1024, timeoutMs: 20_000 };
const INVOICE = "Invoice No. 42 - Total 1,200 EUR - Due 2026-10-01 - Alfa Ltd";

async function pdfError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PdfError) return error.reason;
    throw error;
  }
  throw new Error("expected a PdfError");
}

describe("readPdf", () => {
  it("uses the text layer when every page has one, without rendering", async () => {
    const pdf = buildPdf([{ text: INVOICE }, { text: "Faqja e dyte: kushtet e pageses brenda 30 diteve" }]);
    const result = await readPdf(pdf, limits);
    expect(result).toEqual({
      mode: "text",
      pageCount: 2,
      pages: [
        { page: 1, text: INVOICE },
        { page: 2, text: "Faqja e dyte: kushtet e pageses brenda 30 diteve" },
      ],
    });
    // The caller's buffer is left alone (the caller zeroes it).
    expect(looksLikePdf(pdf)).toBe(true);
  });

  it("renders pages to grayscale PNGs when a page has no text layer", async () => {
    const result = await readPdf(buildPdf([{ text: INVOICE }, { box: true }]), limits);
    if (result.mode !== "images") throw new Error(result.mode);
    expect(result).toMatchObject({ pageCount: 2, pagesRead: 2 });
    expect(result.images.map((image) => image.page)).toEqual([1, 2]);
    for (const image of result.images) {
      expect(image.mimeType).toBe("image/png");
      expect(image.width * image.height).toBeLessThanOrEqual(limits.maxPagePixels);
      const decoded = decodeGrayPng(image.bytes);
      expect([decoded.width, decoded.height]).toEqual([image.width, image.height]);
    }
    // The box page is mostly ink where the rectangle is; the text page has some dark pixels too.
    const dark = (bytes: Uint8Array) => decodeGrayPng(bytes).pixels.filter((value) => value < 128).length;
    expect(dark(result.images[1]!.bytes)).toBeGreaterThan(50_000);
    expect(dark(result.images[0]!.bytes)).toBeGreaterThan(100);
  });

  it("caps pages, pixels per page, pixels per document, image bytes, and extreme page shapes", async () => {
    const scanned = buildPdf(Array.from({ length: 12 }, () => ({ box: true })));
    const capped = await readPdf(scanned, { ...limits, maxPages: 3 });
    expect(capped).toMatchObject({ mode: "images", pageCount: 12, pagesRead: 3 });
    if (capped.mode !== "images") throw new Error();
    expect(capped.images).toHaveLength(3);

    const small = await readPdf(scanned, { ...limits, maxPages: 5, maxPagePixels: 100_000, maxTotalPixels: 250_000 });
    if (small.mode !== "images") throw new Error();
    expect(small.images).toHaveLength(2);
    for (const image of small.images) expect(image.width * image.height).toBeLessThanOrEqual(100_000);

    const first = capped.images[0]!.bytes.byteLength;
    const byBytes = await readPdf(scanned, { ...limits, maxPages: 5, maxImageBytes: first * 2 + 1 });
    if (byBytes.mode !== "images") throw new Error();
    expect(byBytes.images).toHaveLength(2);
    // Not even one page fits in one byte of PNG output.
    expect(await pdfError(readPdf(scanned, { ...limits, maxImageBytes: 1 }))).toBe("pdf_empty");

    const strip = await readPdf(buildPdf([{ box: true, width: 14_000, height: 10 }]), limits);
    if (strip.mode !== "images") throw new Error();
    expect(strip.images[0]!.width).toBeLessThanOrEqual(MAX_RENDER_SIDE);
    expect(strip.images[0]!.height).toBeGreaterThanOrEqual(1);
  });

  it("fails cleanly on encrypted, broken, and empty documents and on the deadline", async () => {
    expect(await pdfError(readPdf(buildPdf([{ text: INVOICE }], { password: true }), limits))).toBe("pdf_encrypted");
    expect(await pdfError(readPdf(Buffer.from("%PDF-1.7\nthis is not really a pdf\n%%EOF"), limits))).toBe("invalid_pdf");
    expect(await pdfError(readPdf(Buffer.alloc(0), limits))).toBe("invalid_pdf");
    const truncated = buildPdf([{ text: INVOICE }]).subarray(0, 120);
    expect(["invalid_pdf", "pdf_empty"]).toContain(await pdfError(readPdf(truncated, limits)));
    expect(await pdfError(readPdf(buildPdf([]), limits))).toBe("pdf_empty");
    expect(await pdfError(readPdf(buildPdf([{ box: true }]), { ...limits, timeoutMs: 1 }))).toBe("pdf_timeout");
  });
});

describe("usableText", () => {
  it("keeps real text and rejects short or garbled text layers", () => {
    expect(usableText("  Invoice\r\nNo. 42\u0000\n\n\n\nTotal 1,200 EUR  ")).toBe("Invoice\nNo. 42\n\nTotal 1,200 EUR");
    expect(usableText("Faqe 1")).toBeNull();
    expect(usableText("".repeat(20))).toBeNull();
    expect(usableText("�".repeat(10) + "abcdefghij".repeat(3))).toBeNull();
    expect(usableText("Hello, here is the signed contract")).toBe("Hello, here is the signed contract");
  });

  it("recognizes a PDF header", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.4\n"))).toBe(true);
    expect(looksLikePdf(Buffer.from("\x89PNG\r\n"))).toBe(false);
  });
});
