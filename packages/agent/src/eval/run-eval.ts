/**
 * Runs the task-analysis fixtures against a REAL provider configured through environment variables and
 * prints precision/recall per action type.
 *
 *   AI_TEXT_PROVIDER=openai AI_TEXT_MODEL=<model> AI_TEXT_API_KEY=... pnpm --filter @wabrain/agent eval
 *   Options: --case <id> (repeatable), --tag <tag>, --verbose
 *
 * The fixtures are synthetic. This sends them (never real chats) to the configured provider.
 */
import { analyzeChat } from "../analysis/analyze.js";
import { PROMPT_VERSION } from "../analysis/prompt.js";
import { createProviders, describeRole, providersConfigFromEnv } from "../providers.js";
import { evalCases } from "./fixtures/index.js";
import { buildCaseMemory, formatSummary, scoreCase, summarize, type CaseScore } from "./harness.js";

function parseArgs(argv: string[]) {
  const cases: string[] = [];
  const tags: string[] = [];
  let verbose = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--case" && argv[index + 1]) cases.push(argv[++index]!);
    else if (arg === "--tag" && argv[index + 1]) tags.push(argv[++index]!);
    else if (arg === "--verbose" || arg === "-v") verbose = true;
  }
  return { cases, tags, verbose };
}

async function main(): Promise<number> {
  const config = providersConfigFromEnv(process.env);
  if (!config.success) {
    console.error("No text provider configured. Set at least AI_TEXT_PROVIDER and AI_TEXT_MODEL (and AI_TEXT_API_KEY / AI_TEXT_BASE_URL as needed).");
    for (const issue of config.error.issues) console.error(`  - ${issue.path.join(".") || "config"}: ${issue.message}`);
    return 2;
  }
  const providers = createProviders(config.data);
  const args = parseArgs(process.argv.slice(2));
  const selected = evalCases.filter(
    (evalCase) =>
      (args.cases.length === 0 || args.cases.includes(evalCase.id)) &&
      (args.tags.length === 0 || args.tags.some((tag) => evalCase.tags.includes(tag))),
  );
  console.log(`Model: ${describeRole(providers.text)} · prompt ${PROMPT_VERSION} · ${selected.length} case(s)\n`);

  const scores: CaseScore[] = [];
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const evalCase of selected) {
    try {
      const result = await analyzeChat(providers, buildCaseMemory(evalCase), { maxRetries: 1 });
      const score = scoreCase(evalCase, result.actions);
      scores.push(score);
      inputTokens += result.run.inputTokens ?? 0;
      outputTokens += result.run.outputTokens ?? 0;
      const ok = score.problems.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  ${evalCase.id}  (${result.run.latencyMs} ms)`);
      if (!ok || args.verbose) {
        for (const problem of score.problems) console.log(`        ${problem}`);
        if (args.verbose) {
          for (const action of result.actions) console.log(`        -> ${JSON.stringify(action)}`);
          for (const dropped of result.dropped) console.log(`        dropped (${dropped.reason}): ${JSON.stringify(dropped.raw)}`);
        }
      }
    } catch (error) {
      errors += 1;
      console.log(`ERROR ${evalCase.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${formatSummary(summarize(scores))}`);
  console.log(`errors: ${errors} · tokens in/out: ${inputTokens}/${outputTokens}`);
  return errors > 0 && scores.length === 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
