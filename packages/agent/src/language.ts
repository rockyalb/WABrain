/**
 * Cheap deterministic language tagging, used only as a fallback when a model did not report a language.
 * Recognises non-Latin scripts and the most common Latin-script languages by their frequent words; works
 * on text typed without diacritics. Returns the dominant language of mixed text, or null when there is
 * not enough signal.
 */

export type LanguageTag = "en" | "es" | "fr" | "de" | "it" | "pt" | "el" | "ar" | "he" | "ja" | "ko" | "zh" | "th" | (string & {});

/** Frequent words per language, folded (no diacritics). Words shared by several languages are left out. */
const WORDS: Record<string, Set<string>> = {
  en: words(`the is are was were you he she we they it its of and or but in on at for with this that these those
    will would can could should please thanks thank send sent tomorrow today yesterday what when where why how
    not yes does did done have has had my your our their been being from by about just also
    let lets know need call meeting invoice contract check sure okay great good morning evening night
    week next month end friday monday tuesday wednesday thursday saturday sunday
    here there there's it's i'm i'll don't can't won't didn't doesn't`),
  es: words(`el los las una por para con que esta estoy pero muy gracias hola manana hoy ayer semana
    cuando donde porque puedes enviar envia enviame necesito tambien bueno vale factura contrato lunes viernes`),
  fr: words(`le les une des est sont avec pour dans pas vous nous merci bonjour demain aujourd'hui hier semaine
    quand pourquoi peux envoyer envoie besoin aussi bien facture contrat lundi vendredi c'est je`),
  de: words(`der die das und ist sind nicht mit fur ich du wir sie ein eine bitte danke morgen heute gestern woche
    wann warum kannst schicken schick brauche auch gut rechnung vertrag montag freitag`),
  it: words(`che sono il lo gli della delle grazie ciao domani oggi come stai bene molto questo questa perche anche
    settimana quando puoi mandare mandami fattura contratto lunedi venerdi`),
  pt: words(`os uma com nao voce obrigado obrigada ola amanha hoje ontem semana quando porque pode enviar
    envia preciso tambem bom fatura contrato segunda sexta`),
};

const SCRIPTS: [RegExp, LanguageTag][] = [
  [/\p{Script=Greek}/gu, "el"],
  [/\p{Script=Arabic}/gu, "ar"],
  [/\p{Script=Hebrew}/gu, "he"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/gu, "ja"],
  [/\p{Script=Hangul}/gu, "ko"],
  [/\p{Script=Han}/gu, "zh"],
  [/\p{Script=Thai}/gu, "th"],
];

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

const fold = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

export function detectLanguage(text: string | null | undefined): LanguageTag | null {
  if (!text) return null;
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return null;

  // Non-Latin scripts first. Kana decides Japanese before Han does.
  for (const [script, tag] of SCRIPTS) {
    if ((text.match(script) ?? []).length > letters.length / 2) return tag;
  }
  if ((text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length > 0 && (text.match(/\p{Script=Han}/gu) ?? []).length > 0) return "ja";

  const scores = new Map<string, number>();
  for (const word of fold(text).match(/[\p{L}']+/gu) ?? []) {
    const bare = word.replace(/^'+|'+$/g, "");
    const hits = Object.keys(WORDS).filter((tag) => WORDS[tag]?.has(bare));
    // A word common to several languages carries no signal.
    const [tag] = hits;
    if (hits.length !== 1 || !tag) continue;
    scores.set(tag, (scores.get(tag) ?? 0) + 1);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 1) return null;
  if (second && second[1] === best[1]) return null;
  return best[0];
}
