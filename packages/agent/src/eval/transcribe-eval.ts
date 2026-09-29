/**
 * Transcribes every audio file in a folder with the configured transcription provider and prints the
 * results, to compare models on real voice notes in your language before committing to one.
 *
 *   AI_TRANSCRIPTION_PROVIDER=openai AI_TRANSCRIPTION_MODEL=<model> AI_TRANSCRIPTION_API_KEY=... \
 *     pnpm --filter @wabrain/agent transcribe-eval /path/to/voice-notes [--language es]
 *
 * Put a reference transcript next to a file as <name>.txt to get a word error rate.
 */
import { readFile, readdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { transcribeAudio } from "../media.js";
import { createProviders, describeRole, providersConfigFromEnv } from "../providers.js";

const AUDIO_TYPES: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
};

/** Word error rate on lowercased, punctuation-free, diacritic-folded words. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let previous = Array.from({ length: hyp.length + 1 }, (_, index) => index);
  for (let i = 1; i <= ref.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[hyp.length]! / ref.length;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const languageIndex = args.indexOf("--language");
  const language = languageIndex >= 0 ? args[languageIndex + 1] : undefined;
  const folder = args.find((arg, index) => !arg.startsWith("--") && !(languageIndex >= 0 && index === languageIndex + 1));
  if (!folder) {
    console.error("Usage: pnpm --filter @wabrain/agent transcribe-eval <folder> [--language es]");
    return 2;
  }

  // The registry requires a text role; it is never called here, so borrow the transcription settings.
  const env = { ...process.env };
  if (!env.AI_TEXT_PROVIDER && !env.AI_TEXT_MODEL && env.AI_TRANSCRIPTION_PROVIDER) {
    env.AI_TEXT_PROVIDER = env.AI_TRANSCRIPTION_PROVIDER;
    env.AI_TEXT_MODEL = "unused";
    env.AI_TEXT_BASE_URL = env.AI_TRANSCRIPTION_BASE_URL;
  }
  const config = providersConfigFromEnv(env);
  if (!config.success) {
    console.error("Provider configuration is incomplete:");
    for (const issue of config.error.issues) console.error(`  - ${issue.path.join(".") || "config"}: ${issue.message}`);
    return 2;
  }
  const providers = createProviders(config.data);
  if (!providers.transcription) {
    console.error("No transcription provider configured. Set AI_TRANSCRIPTION_PROVIDER and AI_TRANSCRIPTION_MODEL.");
    return 2;
  }

  let entries: string[];
  try {
    entries = (await readdir(folder)).sort();
  } catch (error) {
    console.error(`Cannot read ${folder}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const files = entries.filter((name) => AUDIO_TYPES[extname(name).toLowerCase()]);
  if (files.length === 0) {
    console.error(`No audio files (${Object.keys(AUDIO_TYPES).join(", ")}) in ${folder}`);
    return 2;
  }

  console.log(`Model: ${describeRole(providers.transcription)} · language hint: ${language ?? "none"} · ${files.length} file(s)\n`);
  const rates: number[] = [];
  let totalMs = 0;
  for (const name of files) {
    const path = join(folder, name);
    try {
      const bytes = new Uint8Array(await readFile(path));
      const result = await transcribeAudio(providers, bytes, AUDIO_TYPES[extname(name).toLowerCase()]!, language ?? null);
      totalMs += result.run.latencyMs;
      console.log(`## ${name}  (${result.durationInSeconds?.toFixed(1) ?? "?"} s audio, ${result.run.latencyMs} ms, language ${result.language ?? "?"})`);
      console.log(result.text || "(empty transcript)");
      const reference = await readFile(join(folder, `${basename(name, extname(name))}.txt`), "utf8").catch(() => null);
      if (reference !== null) {
        const wer = wordErrorRate(reference, result.text);
        rates.push(wer);
        console.log(`WER vs reference: ${(wer * 100).toFixed(1)}%`);
      }
      console.log("");
    } catch (error) {
      console.log(`## ${name}\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  console.log(`Total latency: ${totalMs} ms`);
  if (rates.length > 0) console.log(`Mean WER over ${rates.length} referenced file(s): ${((rates.reduce((a, b) => a + b, 0) / rates.length) * 100).toFixed(1)}%`);
  return 0;
}

// Run only as a script (the WER helper is imported by tests).
if (process.argv[1] && /transcribe-eval\.[cm]?[jt]s$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
