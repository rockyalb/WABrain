import { z } from "zod";

/**
 * Model-facing schema. Deliberately simpler and flatter than the contract's TaskAction union so every
 * provider (OpenAI strict JSON schema, Anthropic, Ollama) can follow it: every field is present, unused
 * fields are null, no numeric or pattern constraints. The agent validates and converts it afterwards.
 */
export const ModelDueSchema = z
  .object({
    date: z.string().describe("Local calendar date YYYY-MM-DD"),
    time: z.string().nullable().describe("Local time HH:mm (24h) only when a time was stated, else null"),
  })
  .nullable();

export const ModelTaskActionSchema = z.object({
  type: z.enum(["create", "complete", "cancel", "reschedule", "merge"]),
  kind: z.enum(["todo", "waiting_on"]).nullable().describe("create only: todo = owner must act; waiting_on = owner waits on someone else"),
  title: z.string().nullable().describe("create only: short imperative title in the conversation's language"),
  description: z.string().nullable().describe("create only: one sentence with who/what"),
  language: z.string().nullable().describe('create only: language of the title, e.g. "en" or "es"'),
  due: ModelDueSchema.describe("create: due or null when none stated; reschedule: the new due"),
  taskId: z.string().nullable().describe("complete/cancel/reschedule: id of an open or pending task from the lists"),
  taskIds: z.array(z.string()).nullable().describe("merge only: open task ids, the one to keep first"),
  contextId: z.string().nullable().describe("create only: a listed context id to override the chat default, else null"),
  contextReason: z.string().nullable().describe("why the context override applies, else null"),
  handled: z
    .object({
      status: z.enum(["done", "cancelled"]),
      evidenceMessageIds: z.array(z.string()).describe("ids of the new messages showing it done or no longer needed"),
    })
    .nullable()
    .describe("create only: the new messages already show this task done or no longer needed, else null"),
  confidence: z.number().describe("0 to 1"),
  ambiguityReasons: z.array(z.string()),
  evidenceMessageIds: z.array(z.string()).describe("ids of the messages that justify this action"),
});

export const ModelAnalysisSchema = z.object({
  actions: z.array(ModelTaskActionSchema),
});

export type ModelTaskAction = z.infer<typeof ModelTaskActionSchema>;
export type ModelAnalysis = z.infer<typeof ModelAnalysisSchema>;
