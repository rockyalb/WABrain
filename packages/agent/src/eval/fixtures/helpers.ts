import type { EvalMessage } from "../types.js";

/** A message written by the owner at local time "HH:mm" on the case date. */
export const own = (id: string, at: string, text: string, extra: Partial<EvalMessage> = {}): EvalMessage => ({
  id,
  at,
  fromOwner: true,
  text,
  ...extra,
});

/** A message written by the other person (or a named group member). */
export const them = (id: string, at: string, text: string, sender = "Ana", extra: Partial<EvalMessage> = {}): EvalMessage => ({
  id,
  at,
  fromOwner: false,
  sender,
  text,
  ...extra,
});

/** Default case date: Wednesday 23 September 2026 (Europe/Rome, UTC+2). */
export const DATE = "2026-09-23";
export const TODAY = "2026-09-23";
export const TOMORROW = "2026-09-24";
export const FRIDAY = "2026-09-25";
export const SATURDAY = "2026-09-26";
export const NEXT_MONDAY = "2026-09-28";
export const END_OF_MONTH = "2026-09-30";

export const WORK_CHAT = { name: "Ana (Acme)", isGroup: false, defaultContextId: "ctx-work" };
export const PERSONAL_CHAT = { name: "Mira", isGroup: false, defaultContextId: "ctx-personal" };
