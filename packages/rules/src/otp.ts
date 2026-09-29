import { foldText, wholeWord } from "./text.js";

/**
 * One-time code / verification message detector.
 *
 * A message is a one-time code when it contains a code-shaped token AND either
 *  - a strong verification cue anywhere (OTP, verification, "do not share", ...), or
 *  - a weak cue ("code", "PIN") directly attached to the code ("code: 4821", "482913 is your code"), or
 *  - a weak cue anywhere when the sender looks like a bank or verification service.
 * Everything is matched on diacritic-folded lowercase text, so text typed without diacritics still matches.
 */

/** 4–8 digits, "123-456" / "123 456", or Google-style "G-123456". */
const CODE = String.raw`(?:[a-z]-)?(?:\d{3}[- ]\d{3}|\d{4,8})`;
const CODE_RE = wholeWord(CODE);

const STRONG_CUES = [
  String.raw`otp`,
  String.raw`one[- ]time`,
  String.raw`verification`,
  String.raw`verify(?:ing)?`,
  String.raw`passcode`,
  String.raw`2fa`,
  String.raw`two[- ]factor`,
  String.raw`(?:security|login|sign[- ]in|authentication|confirmation|access|activation) code`,
  String.raw`do not share`,
  String.raw`don'?t share`,
  String.raw`never share`,
  String.raw`not share (?:it|this)`,
];
const STRONG_RE = wholeWord(STRONG_CUES.join("|"));

const WEAK = String.raw`code|pin`;
/** "code: 1234", "your code is 1234", "code is 1234", "PIN 1234". */
const WEAK_BEFORE_RE = wholeWord(
  String.raw`(?:${WEAK})\s*(?:is|=)?\s*[:#-]?\s*${CODE}`,
);
/** "1234 is your code", "1234 is your login code". */
const WEAK_AFTER_RE = wholeWord(String.raw`${CODE}\s*(?:is your)\s*(?:\p{L}+\s+){0,2}(?:${WEAK})`);
const WEAK_ANY_RE = wholeWord(WEAK);

/** Codes that are not secrets: postal codes, promo codes, product codes. */
const NOT_SECRET_RE = wholeWord(
  String.raw`postal|zip|promo\p{L}*|discount|coupon\p{L}*|voucher\p{L}*|product\p{L}*|item|article|tax|vat|swift|iban`,
);

/** Sender names that typically send verification codes. */
const SERVICE_SENDER_RE = wholeWord(
  String.raw`bank\p{L}*|otp|paypal|revolut|wise|stripe|amazon|google|microsoft|apple|meta|facebook|instagram|whatsapp|verify|verification|noreply|no-reply|security|auth`,
);

export interface OtpHints {
  /** Contact or business name of the sender, when known. */
  senderName?: string | null;
}

export function isOneTimeCode(text: string, hints: OtpHints = {}): boolean {
  if (!text) return false;
  const folded = foldText(text);
  if (!CODE_RE.test(folded)) return false;

  if (STRONG_RE.test(folded)) return true;

  const serviceSender = hints.senderName ? SERVICE_SENDER_RE.test(foldText(hints.senderName)) : false;
  if (NOT_SECRET_RE.test(folded) && !serviceSender) return false;

  // Short, code-centric messages only: a long message that mentions "code 2024" is conversation.
  if (folded.length <= 200 && (WEAK_BEFORE_RE.test(folded) || WEAK_AFTER_RE.test(folded))) return true;
  if (serviceSender && WEAK_ANY_RE.test(folded)) return true;
  return false;
}
