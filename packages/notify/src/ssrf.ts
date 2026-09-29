/**
 * SSRF guard for push endpoints: https only, and the host must not resolve
 * to a private, loopback, link-local, or otherwise internal address — unless
 * it is the configured ntfy host. Checked when an endpoint is registered and
 * again before every send, because DNS can change (rebinding). Shared by the
 * API (registration) and the push sender.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    const first = parseInt(lower.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xff00) === 0xff00 || // ff00::/8 multicast
      lower.startsWith("64:ff9b:") || // NAT64
      lower.startsWith("2001:db8:") // documentation
    );
  }
  return true;
}

export type Resolver = (hostname: string) => Promise<string[]>;
const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address);

export class UnsafeUrlError extends Error {}

export async function assertSafePushEndpoint(
  endpoint: string,
  options: { allowHost?: string | null; resolve?: Resolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnsafeUrlError("endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("endpoint must use https");
  if (url.username || url.password) throw new UnsafeUrlError("endpoint must not contain credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (options.allowHost && host === options.allowHost) return url;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UnsafeUrlError("endpoint host is not public");
  }
  const addresses = isIP(host) ? [host] : await (options.resolve ?? defaultResolver)(host).catch(() => []);
  if (!addresses.length) throw new UnsafeUrlError("endpoint host does not resolve");
  if (addresses.some(isPrivateAddress)) throw new UnsafeUrlError("endpoint resolves to a private address");
  return url;
}
