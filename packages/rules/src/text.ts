/** Small Unicode-aware text helpers shared by the rule modules. */

/** Lowercase and strip combining marks, so "Café" and "cafe" compare equal. */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wraps a pattern so it only matches as a whole word (Unicode letters and digits count as word characters). */
export function wholeWord(pattern: string, flags = "iu"): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, flags);
}

/**
 * The user part of a WhatsApp JID, without the device suffix:
 * "447691234567:12@s.whatsapp.net" and "447691234567@c.us" both give "447691234567".
 */
export function jidUser(jid: string): string {
  const at = jid.indexOf("@");
  const user = at === -1 ? jid : jid.slice(0, at);
  const colon = user.indexOf(":");
  return (colon === -1 ? user : user.slice(0, colon)).trim().toLowerCase();
}

export function sameJid(a: string, b: string): boolean {
  const ua = jidUser(a);
  return ua.length > 0 && ua === jidUser(b);
}
