/**
 * Tiny PDF fixtures for tests, generated in memory (no binary files in the repository): pages with
 * a Helvetica text layer and/or a filled rectangle (a "scanned" page without text), plus a PDF with
 * a password (Standard security handler) and a helper that decodes the renderer's grayscale PNGs.
 */
import { inflateSync } from "node:zlib";

export interface FixturePage {
  /** Drawn as real text (a text layer the extractor can read). */
  text?: string;
  /** Draws a black rectangle: ink without any text layer. */
  box?: boolean;
  /** Page size in points (default US Letter). */
  width?: number;
  height?: number;
}

const escapePdfString = (text: string) => text.replace(/[()\\]/g, (char) => `\\${char}`);

export function buildPdf(pages: readonly FixturePage[], options: { password?: boolean } = {}): Buffer {
  const objects: Array<string | null> = [];
  const add = (body: string | null) => objects.push(body);
  const catalog = add(null);
  const pagesId = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const page of pages) {
    const ops: string[] = [];
    if (page.text) ops.push(`BT /F1 14 Tf 72 700 Td (${escapePdfString(page.text)}) Tj ET`);
    if (page.box) ops.push("0 0 0 rg 100 100 200 300 re f");
    const content = ops.join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width ?? 612} ${page.height ?? 792}] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  // A user password is required: the empty password does not match /U, so readers must refuse it.
  const encrypt = options.password
    ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${"11".repeat(32)}> /U <${"22".repeat(32)}> >>`)
    : null;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const encryptRef = encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${"ab".repeat(16)}> <${"ab".repeat(16)}>]` : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Decodes an 8-bit grayscale PNG with filter 0 rows (what the renderer writes). */
export function decodeGrayPng(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const buffer = Buffer.from(png);
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 0) throw new Error("not 8-bit grayscale");
    } else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error("unexpected filter");
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, pixels };
}
