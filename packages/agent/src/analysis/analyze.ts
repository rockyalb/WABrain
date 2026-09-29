import type { TaskAction } from "@wabrain/contracts";
import { generateStructured, type CallOptions, type ModelRun } from "../generate.js";
import type { Providers } from "../providers.js";
import type { WorkingMemory } from "../working-memory.js";
import { PROMPT_VERSION, TASK_ANALYSIS_SYSTEM_PROMPT, renderTaskAnalysisPrompt } from "./prompt.js";
import { ModelAnalysisSchema } from "./schema.js";
import { validateModelActions, type DroppedAction } from "./validate.js";

export interface AnalyzeChatResult {
  /** Validated contract actions. The rules package's decideAction decides what happens to each. */
  actions: TaskAction[];
  /** Parallel to actions: why the model overrode the chat's default context, or null. */
  contextReasons: Array<string | null>;
  /** Model actions removed by validation, for the analysis_runs audit record. */
  dropped: DroppedAction[];
  run: ModelRun;
}

/**
 * Asks the text model for task actions over one chat's working memory, then validates and resolves them
 * deterministically. Returns no actions (and makes no call) when the burst is empty.
 */
export async function analyzeChat(providers: Providers, memory: WorkingMemory, options: CallOptions = {}): Promise<AnalyzeChatResult> {
  if (!memory.messages.some((message) => message.isNew)) {
    return {
      actions: [],
      contextReasons: [],
      dropped: [],
      run: {
        provider: providers.text.provider,
        modelId: providers.text.modelId,
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      },
    };
  }

  const { output, run } = await generateStructured({
    role: providers.text,
    schema: ModelAnalysisSchema,
    name: "task_actions",
    description: "Task actions for the owner's to-do list, justified by the new chat messages.",
    instructions: TASK_ANALYSIS_SYSTEM_PROMPT,
    prompt: renderTaskAnalysisPrompt(memory),
    promptVersion: PROMPT_VERSION,
    options,
  });

  const validated = validateModelActions(output, memory, {
    timezone: memory.now.timezone,
    endOfWorkDay: memory.now.endOfWorkDay,
  });
  return { ...validated, run };
}
