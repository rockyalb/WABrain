/**
 * Cheap per-message language tag from frequent words, used until the agent refines it. Recognises the
 * most common Latin-script languages; returns null when unsure.
 */
const WORDS: Record<string, Set<string>> = {
  en: words("the and is are you to of it for that can will please thanks thank what when where why how i'm we they this with have has send sent tomorrow today yes not does meeting call check done let's lets could would should about"),
  es: words("el los las una por para con que esta pero muy gracias hola manana hoy cuando donde porque puedes enviar necesito tambien"),
  fr: words("le les une des est sont avec pour dans pas vous nous merci bonjour demain quand pourquoi peux envoyer besoin aussi"),
  de: words("der die das und ist sind nicht mit fur ich du wir ein eine bitte danke morgen heute wann warum kannst schicken brauche auch"),
  it: words("che sono il lo gli della grazie ciao domani oggi come bene molto questo perche anche quando puoi mandare"),
  pt: words("os uma com nao voce obrigado obrigada ola amanha hoje quando porque pode enviar preciso tambem"),
};

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/));
}

export function detectLanguage(text: string): string | null {
  const found = text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}']+/gu);
  if (!found?.length) return null;
  const scores = new Map<string, number>();
  for (const word of found) {
    const hits = Object.keys(WORDS).filter((tag) => WORDS[tag]?.has(word));
    const [tag] = hits;
    if (hits.length === 1 && tag) scores.set(tag, (scores.get(tag) ?? 0) + 1);
  }
  const [best, second] = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!best || (second && second[1] === best[1])) return null;
  return best[0];
}
