import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language.js";

describe("detectLanguage", () => {
  it.each([
    ["Can you send me the contract tomorrow?", "en"],
    ["I'll call the notary on Monday", "en"],
    ["Don't worry, I booked it already", "en"],
    ["¿Puedes enviarme la factura mañana? Gracias", "es"],
    ["puedes enviar el contrato manana", "es"],
    ["Merci, je peux envoyer la facture demain", "fr"],
    ["Kannst du mir bitte den Vertrag schicken? Danke", "de"],
    ["Ciao, come stai? Tutto bene grazie", "it"],
    ["Obrigado, pode enviar a fatura amanhã?", "pt"],
    ["Γεια σου, τι κάνεις;", "el"],
    ["مرحبا كيف حالك", "ar"],
    ["明日は会議があります", "ja"],
  ])("%s -> %s", (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });

  it("returns the dominant language of mixed text", () => {
    expect(detectLanguage("Please check the invoice and the contract today, gracias")).toBe("en");
    expect(detectLanguage("ok, puedes enviar la factura hoy? gracias, thanks")).toBe("es");
  });

  it.each([[""], ["ok"], ["👍"], ["12345"], [null], [undefined]])("returns null without signal: %s", (text) => {
    expect(detectLanguage(text)).toBeNull();
  });
});
