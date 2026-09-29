import { afterEach, describe, expect, it, vi } from "vitest";
import { wordErrorRate } from "./eval/transcribe-eval.js";
import { describeImage, describePdfPages, transcribeAudio } from "./media.js";
import { ProviderNotConfiguredError, createProviders } from "./providers.js";
import { createMockProviders, mockJsonModel, mockTranscriptionModel } from "./testing/index.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const fileParts = (model: ReturnType<typeof mockJsonModel>): Array<{ type: string; mediaType?: string }> =>
  model.doGenerateCalls[0]!.prompt
    .flatMap((message): unknown[] => (Array.isArray(message.content) ? [...message.content] : []))
    .filter((part): part is { type: string; mediaType?: string } => (part as { type?: string }).type === "file");

describe("describeImage", () => {
  it("sends the image to the vision role and returns description, OCR and language", async () => {
    const vision = mockJsonModel({ description: "A receipt from a pharmacy.", ocrText: "PHARMACY\nTotal 12.00 EUR", language: "Spanish" });
    const text = mockJsonModel({ actions: [] });
    const result = await describeImage(createMockProviders({ text, vision }), png, "image/png");
    expect(result).toMatchObject({ description: "A receipt from a pharmacy.", ocrText: "PHARMACY\nTotal 12.00 EUR", language: "es" });
    expect(text.doGenerateCalls).toHaveLength(0);
    expect(fileParts(vision)).toHaveLength(1);
    expect(fileParts(vision)[0]).toMatchObject({ mediaType: "image/png" });
    expect(JSON.stringify(vision.doGenerateCalls[0]!.prompt[0])).toContain("UNTRUSTED");
  });

  it("detects the language from OCR text when the model gives none", async () => {
    const vision = mockJsonModel({ description: "Screenshot of a chat.", ocrText: "send me the invoice tomorrow", language: null });
    expect((await describeImage(createMockProviders({ vision }), png, "image/png")).language).toBe("en");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeAudio", () => {
  it("transcribes with the transcription role and normalizes the language", async () => {
    const providers = createMockProviders({ transcription: mockTranscriptionModel(" hi, send me the quote ", "spanish") });
    const result = await transcribeAudio(providers, new Uint8Array([1, 2, 3]), "audio/ogg; codecs=opus", "es");
    expect(result).toMatchObject({ text: "hi, send me the quote", language: "es", durationInSeconds: 4.2 });
    expect(result.run.modelId).toBe("mock-transcription");
  });

  it("falls back to text detection, then the hint", async () => {
    const detected = await transcribeAudio(createMockProviders({ transcription: mockTranscriptionModel("send me the invoice today please") }), new Uint8Array([1]), "audio/mpeg");
    expect(detected.language).toBe("en");
    const hinted = await transcribeAudio(createMockProviders({ transcription: mockTranscriptionModel("hmm") }), new Uint8Array([1]), "audio/mpeg", "es");
    expect(hinted.language).toBe("es");
  });

  it("returns an empty transcript for silence instead of failing", async () => {
    const result = await transcribeAudio(createMockProviders({ transcription: mockTranscriptionModel("") }), new Uint8Array([1]), "audio/ogg", "es");
    expect(result).toMatchObject({ text: "", language: "es", run: { modelId: "mock-transcription" } });
  });

  it("asks OpenAI for plain json with a language hint, which gpt-transcribe accepts", async () => {
    const forms: FormData[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return new Response(JSON.stringify({ text: "hola" }), { headers: { "content-type": "application/json" } });
    });
    const providers = createProviders({
      text: { provider: "openai", model: "gpt-6-luna", apiKey: "k" },
      transcription: { provider: "openai", model: "gpt-transcribe", apiKey: "k" },
    });
    const result = await transcribeAudio(providers, new Uint8Array([79, 103, 103, 83]), "audio/ogg", "es");
    expect(result).toMatchObject({ text: "hola", language: "es" });
    expect(forms[0]?.get("response_format")).toBe("json");
    expect(forms[0]?.get("language")).toBe("es");
  });

  it("names the language in the prompt when the model rejects the language code", async () => {
    const forms: FormData[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      forms.push(form);
      if (form.get("language") === "es") {
        const error = {
          error: {
            message: "Language code 'sq' is not recognized. Try adding the language name to your prompt.",
            type: "invalid_request_error",
            param: "language",
            code: "unsupported_language",
          },
        };
        return new Response(JSON.stringify(error), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ text: "hola" }), { headers: { "content-type": "application/json" } });
    });
    const providers = createProviders({
      text: { provider: "openai", model: "gpt-6-luna", apiKey: "k" },
      transcription: { provider: "openai", model: "gpt-transcribe", apiKey: "k" },
    });
    const audio = new Uint8Array([79, 103, 103, 83]);
    expect(await transcribeAudio(providers, audio, "audio/ogg", "es")).toMatchObject({ text: "hola", language: "es" });
    expect(forms).toHaveLength(2);
    expect(forms[1]?.get("language")).toBeNull();
    expect(forms[1]?.get("prompt")).toBe("The audio is in Spanish.");
    expect(forms[1]?.get("response_format")).toBe("json");

    // The same model is not sent the rejected code again.
    await transcribeAudio(providers, audio, "audio/ogg", "es");
    expect(forms).toHaveLength(3);
    expect(forms[2]?.get("language")).toBeNull();
    expect(forms[2]?.get("prompt")).toBe("The audio is in Spanish.");
  });

  it("does not retry other transcription errors", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Invalid file format.", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const providers = createProviders({
      text: { provider: "openai", model: "gpt-6-luna", apiKey: "k" },
      transcription: { provider: "openai", model: "gpt-transcribe", apiKey: "k" },
    });
    await expect(transcribeAudio(providers, new Uint8Array([1]), "audio/ogg", "es")).rejects.toThrow(/Invalid file format/);
    expect(calls).toBe(1);
  });

  it("fails clearly without a transcription provider or with a non-audio type", async () => {
    await expect(transcribeAudio(createMockProviders({ transcription: null }), new Uint8Array([1]), "audio/ogg")).rejects.toBeInstanceOf(
      ProviderNotConfiguredError,
    );
    await expect(transcribeAudio(createMockProviders(), new Uint8Array([1]), "application/pdf")).rejects.toThrow(/Unsupported/);
  });
});

describe("describePdfPages", () => {
  it("caps the pages sent to the vision model", async () => {
    const vision = mockJsonModel({
      summary: "Rental agreement.",
      pages: [
        { page: 1, text: "RENTAL AGREEMENT" },
        { page: 2, text: "Rent 400 EUR" },
        { page: 9, text: "hallucinated page" },
      ],
      language: "es",
    });
    const pages = Array.from({ length: 10 }, () => ({ bytes: png, mimeType: "image/png" }));
    const result = await describePdfPages(createMockProviders({ vision }), pages, { maxPages: 3 });
    expect(fileParts(vision)).toHaveLength(3);
    expect(result).toMatchObject({ pagesAnalyzed: 3, truncated: true, language: "es", summary: "Rental agreement." });
    expect(result?.pages.map((page) => page.page)).toEqual([1, 2]);
  });

  it("returns null without pages", async () => {
    const vision = mockJsonModel({});
    expect(await describePdfPages(createMockProviders({ vision }), [])).toBeNull();
    expect(vision.doGenerateCalls).toHaveLength(0);
  });
});

describe("wordErrorRate", () => {
  it("ignores case, punctuation and diacritics", () => {
    expect(wordErrorRate("Send me the contract tomorrow.", "send me the contract tomorrow")).toBe(0);
    expect(wordErrorRate("send me the contract tomorrow", "send me the tomorrow")).toBe(0.2);
    expect(wordErrorRate("", "")).toBe(0);
  });
});
