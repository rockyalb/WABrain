/**
 * QR rendering and pairing-payload helpers. The QR code is drawn locally as one
 * SVG path, so the pairing secret never leaves the page (no third-party QR service).
 */
import { encode } from "uqr";

export interface QrPath {
  /** Modules per side, including the quiet zone. */
  size: number;
  /** SVG path data: one 1×1 square per dark module, in module units. */
  path: string;
}

/** Quiet zone of 4 modules, as the QR specification requires for reliable scans. */
export const QUIET_ZONE = 4;

export function qrPath(payload: string, ecc: "L" | "M" | "Q" | "H" = "M"): QrPath {
  const { data, size } = encode(payload, { ecc, border: 0 });
  const segments: string[] = [];
  for (let y = 0; y < size; y++) {
    const row = data[y]!;
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      // Merge horizontal runs of dark modules into one rectangle.
      let run = 1;
      while (x + run < size && row[x + run]) run++;
      segments.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return { size: size + QUIET_ZONE * 2, path: segments.join("") };
}

export interface PairingPayload {
  server: string;
  code: string;
}

/** Parses `wabrain://pair?server=<urlencoded https base URL>&code=<secret>` (docs/API.md). */
export function parsePairingPayload(payload: string): PairingPayload | null {
  const match = /^wabrain:\/\/pair\?(.*)$/.exec(payload.trim());
  if (!match) return null;
  const params = new URLSearchParams(match[1]);
  const server = params.get("server");
  const code = params.get("code");
  if (!server || !code || code.length < 32) return null;
  try {
    const url = new URL(server);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return { server, code };
}

/** Seconds left until `expiresAt` (never negative). */
export function secondsLeft(expiresAt: string, now: number = Date.now()): number {
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/** 600 → "10:00", 59 → "0:59". */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
