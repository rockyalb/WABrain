/**
 * OpenAPI 3.1 document generated from the Zod schemas. Served at
 * GET /v1/openapi.json and written to packages/contracts/openapi.json by
 * `pnpm --filter @wabrain/api openapi`.
 */
import {
  AskRequestSchema,
  AskResponseSchema,
  ChatSchema,
  ContextSchema,
  MessageViewSchema,
  NotificationAckSchema,
  NotificationEventSchema,
  NotificationsResponseSchema,
  PersonFactSchema,
  PersonSchema,
  ReviewItemSchema,
  SettingsSchema,
  TaskActionSchema,
  TaskEventSchema,
  TaskSchema,
} from "@wabrain/contracts";
import { z } from "zod";
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponseObject,
} from "zod-openapi";
import { ErrorResponseSchema } from "../http/errors.js";
import * as S from "../http/schemas.js";

type Security = "device" | "owner" | "none" | "webhook";

interface Op {
  summary: string;
  security: Security;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** status → schema (null = no body). */
  responses: Record<number, z.ZodType | null>;
  /** Error statuses beyond the common ones (status → description). */
  errors?: Record<number, string>;
  mutating?: boolean;
}

const idParam = (name = "id") => z.object({ [name]: z.string() });

const errorResponses = {
  400: "Validation failed",
  401: "Unauthorized",
  404: "Not found",
  409: "Conflict",
  429: "Rate limited",
} as const;

function operation(op: Op): ZodOpenApiOperationObject {
  const responses: Record<string, ZodOpenApiResponseObject> = {};
  for (const [status, schema] of Object.entries(op.responses)) {
    responses[status] = schema
      ? { description: "Success", content: { "application/json": { schema } } }
      : { description: "No content" };
  }
  for (const [status, description] of Object.entries({ ...errorResponses, ...op.errors })) {
    responses[status] ??= { description, content: { "application/json": { schema: ErrorResponseSchema } } };
  }
  const headers =
    op.mutating && op.security !== "none" && op.security !== "webhook"
      ? z.object({ "Idempotency-Key": z.string().max(255).optional() })
      : undefined;
  return {
    summary: op.summary,
    security: op.security === "device" ? [{ deviceToken: [] }] : op.security === "owner" ? [{ ownerSession: [] }] : [],
    requestParams: {
      ...(op.params ? { path: op.params } : {}),
      ...(op.query ? { query: op.query } : {}),
      ...(headers ? { header: headers } : {}),
    },
    ...(op.body ? { requestBody: { content: { "application/json": { schema: op.body } } } } : {}),
    responses: responses as ZodOpenApiOperationObject["responses"],
  };
}

const TaskList = S.listOf(TaskSchema);
const ReviewList = S.listOf(ReviewItemSchema);
const ChatList = S.listOf(ChatSchema);
const PeopleList = S.listOf(PersonSchema);

const routes: Record<string, Partial<Record<"get" | "post" | "patch" | "put" | "delete", Op>>> = {
  "/health": { get: { summary: "Liveness", security: "none", responses: { 200: S.OkSchema } } },
  "/webhooks/openwa": {
    post: {
      summary: "OpenWA webhook (HMAC in X-OpenWA-Signature)",
      security: "webhook",
      body: z.record(z.string(), z.unknown()),
      responses: { 202: S.WebhookAcceptedSchema },
    },
  },
  "/v1/openapi.json": { get: { summary: "This document", security: "none", responses: { 200: z.record(z.string(), z.unknown()) } } },
  "/v1/devices/pair": {
    post: { summary: "Exchange a pairing code for a device token", security: "none", body: S.PairRequestSchema, responses: { 201: S.PairResponseSchema } },
  },
  "/v1/devices/self": { delete: { summary: "Unpair this device", security: "device", responses: { 204: null }, mutating: true } },
  "/v1/sync": { get: { summary: "Full snapshot or delta since a cursor", security: "device", query: S.SyncQuerySchema, responses: { 200: S.SyncResponseSchema } } },
  "/v1/notifications": {
    get: {
      summary: "This device's unacknowledged Review, reminder and summary notifications (fallback for missed pushes)",
      security: "device",
      responses: { 200: NotificationsResponseSchema },
    },
  },
  "/v1/notifications/ack": {
    post: { summary: "Mark notifications as handled on this device", security: "device", body: NotificationAckSchema, responses: { 200: S.OkSchema }, mutating: true },
  },
  "/v1/tasks": {
    get: { summary: "List tasks", security: "device", query: S.TaskListQuerySchema, responses: { 200: TaskList } },
    post: { summary: "Create a manual task", security: "device", body: S.CreateTaskRequestSchema, responses: { 201: TaskSchema, 200: TaskSchema }, mutating: true },
  },
  "/v1/tasks/{id}": {
    get: { summary: "Task with history and evidence", security: "device", params: idParam(), responses: { 200: S.TaskDetailSchema } },
    patch: { summary: "Edit a task", security: "device", params: idParam(), body: S.UpdateTaskRequestSchema, responses: { 200: TaskSchema }, mutating: true },
  },
  "/v1/tasks/{id}/complete": { post: { summary: "Complete (owner)", security: "device", params: idParam(), responses: { 200: TaskSchema }, mutating: true } },
  "/v1/tasks/{id}/reopen": { post: { summary: "Reopen (owner)", security: "device", params: idParam(), responses: { 200: TaskSchema }, mutating: true } },
  "/v1/tasks/{id}/cancel": { post: { summary: "Cancel (owner)", security: "device", params: idParam(), responses: { 200: TaskSchema }, mutating: true } },
  "/v1/task-events/{id}/undo": { post: { summary: "Undo a task event", security: "device", params: idParam(), responses: { 200: TaskSchema }, mutating: true } },
  "/v1/review": { get: { summary: "Pending review items", security: "device", query: S.PageQuerySchema, responses: { 200: ReviewList } } },
  "/v1/review/{id}": {
    get: { summary: "Review item and related or resulting task, including decided items", security: "device", params: idParam(), responses: { 200: S.AcceptReviewResponseSchema } },
  },
  "/v1/review/{id}/accept": {
    post: { summary: "Accept a review item", security: "device", params: idParam(), body: S.AcceptReviewRequestSchema, responses: { 200: S.AcceptReviewResponseSchema }, mutating: true },
  },
  "/v1/review/{id}/reject": { post: { summary: "Reject a review item", security: "device", params: idParam(), responses: { 200: S.RejectReviewResponseSchema }, mutating: true } },
  "/v1/chats": { get: { summary: "List chats", security: "device", query: S.ChatListQuerySchema, responses: { 200: ChatList } } },
  "/v1/chats/{id}": {
    patch: { summary: "Update a chat rule (mode=off purges data)", security: "device", params: idParam(), body: S.UpdateChatRequestSchema, responses: { 200: ChatSchema }, mutating: true },
  },
  "/v1/chats/{id}/data": { delete: { summary: "Delete a chat's stored data", security: "device", params: idParam(), responses: { 204: null }, mutating: true } },
  "/v1/chats/{chatId}/messages": {
    get: { summary: "Conversation around a message", security: "device", params: idParam("chatId"), query: S.MessagesQuerySchema, responses: { 200: S.MessagesResponseSchema } },
  },
  "/v1/people": { get: { summary: "List people", security: "device", query: S.PeopleQuerySchema, responses: { 200: PeopleList } } },
  "/v1/people/{id}": {
    get: { summary: "Get a person", security: "device", params: idParam(), responses: { 200: PersonSchema } },
    patch: { summary: "Edit a person", security: "device", params: idParam(), body: S.UpdatePersonRequestSchema, responses: { 200: PersonSchema }, mutating: true },
  },
  "/v1/people/{id}/facts": {
    post: { summary: "Add an owner fact", security: "device", params: idParam(), body: S.CreateFactRequestSchema, responses: { 201: PersonFactSchema }, mutating: true },
  },
  "/v1/people/{id}/facts/{factId}/sources": {
    get: {
      summary: "A fact's stored source messages, each with its own chatId (purged messages are omitted)",
      security: "device",
      params: z.object({ id: z.string(), factId: z.string() }),
      responses: { 200: S.MessagesResponseSchema },
    },
  },
  "/v1/people/{id}/facts/{factId}": {
    patch: {
      summary: "Edit a fact",
      security: "device",
      params: z.object({ id: z.string(), factId: z.string() }),
      body: S.UpdateFactRequestSchema,
      responses: { 200: PersonFactSchema },
      mutating: true,
    },
    delete: { summary: "Delete a fact", security: "device", params: z.object({ id: z.string(), factId: z.string() }), responses: { 204: null }, mutating: true },
  },
  "/v1/people/{id}/data": { delete: { summary: "Delete a person and their chats' data", security: "device", params: idParam(), responses: { 204: null }, mutating: true } },
  "/v1/contexts": {
    get: { summary: "List contexts", security: "device", responses: { 200: z.array(ContextSchema) } },
    post: { summary: "Create a context", security: "device", body: S.CreateContextRequestSchema, responses: { 201: ContextSchema }, mutating: true },
  },
  "/v1/contexts/{id}": {
    patch: { summary: "Edit a context", security: "device", params: idParam(), body: S.UpdateContextRequestSchema, responses: { 200: ContextSchema }, mutating: true },
    delete: { summary: "Delete a context", security: "device", params: idParam(), query: S.DeleteContextQuerySchema, responses: { 204: null }, mutating: true },
  },
  "/v1/settings": {
    get: { summary: "Settings, with the read-only auto-create status", security: "device", responses: { 200: S.SettingsResponseSchema } },
    patch: { summary: "Edit settings", security: "device", body: S.UpdateSettingsRequestSchema, responses: { 200: SettingsSchema }, mutating: true },
  },
  "/v1/push-endpoints": {
    post: { summary: "Register this device's UnifiedPush endpoint", security: "device", body: S.PushEndpointRequestSchema, responses: { 204: null }, mutating: true },
    delete: { summary: "Remove this device's push endpoint", security: "device", responses: { 204: null }, mutating: true },
  },
  "/v1/ask": {
    post: {
      summary: "Ask your chats: a read-only answer from stored messages, with validated citations",
      security: "device",
      body: AskRequestSchema,
      responses: { 200: AskResponseSchema },
      errors: {
        429: "`rate_limited`: per-device throttling. `budget_exceeded`: the daily text-model budget is used up. Both send Retry-After (seconds); for the budget it points to local midnight",
        503: "The text model did not answer",
      },
    },
  },
  "/setup/bootstrap": { post: { summary: "Create the owner (first run only)", security: "none", body: S.BootstrapRequestSchema, responses: { 201: S.OkSchema } } },
  "/setup/login": { post: { summary: "Owner login (sets session cookie)", security: "none", body: S.PasswordRequestSchema, responses: { 200: S.OkSchema } } },
  "/setup/logout": { post: { summary: "Owner logout", security: "owner", responses: { 200: S.OkSchema } } },
  "/setup/status": { get: { summary: "Health and setup state", security: "owner", responses: { 200: S.SetupStatusSchema } } },
  "/setup/pairing-codes": { post: { summary: "Create a device pairing QR payload", security: "owner", responses: { 201: S.PairingCodeResponseSchema } } },
  "/setup/devices": { get: { summary: "Paired devices", security: "owner", responses: { 200: S.DeviceListSchema } } },
  "/setup/devices/{id}": { delete: { summary: "Revoke a device", security: "owner", params: idParam(), responses: { 204: null }, mutating: true } },
  "/setup/policy": { patch: { summary: "Trial and auto-create policy", security: "owner", body: S.UpdatePolicyRequestSchema, responses: { 200: SettingsSchema }, mutating: true } },
  "/setup/providers": {
    get: { summary: "Model provider settings per role (API keys are never returned)", security: "owner", responses: { 200: S.ProvidersResponseSchema } },
    put: {
      summary: "Save model provider settings; API keys are write-only and stored encrypted",
      security: "owner",
      body: S.UpdateProvidersRequestSchema,
      responses: { 200: S.ProvidersResponseSchema },
      mutating: true,
    },
  },
  "/setup/providers/test": {
    post: { summary: "Make one small test call per configured role", security: "owner", body: S.ProviderTestRequestSchema, responses: { 200: S.ProviderTestResponseSchema } },
  },
  "/setup/openwa/status": {
    get: { summary: "OpenWA reachability and the WhatsApp session state (read-only key)", security: "owner", responses: { 200: S.OpenWaStatusResponseSchema } },
  },
  "/setup/openwa/test": {
    post: {
      summary: "Check the read key with GET requests only; warns when the key could send",
      security: "owner",
      responses: { 200: S.OpenWaTestResponseSchema },
    },
  },
  "/setup/openwa/qr": {
    get: { summary: "Where to scan the WhatsApp QR code (the OpenWA dashboard)", security: "owner", responses: { 200: S.OpenWaQrResponseSchema } },
  },
  "/setup/jobs/failures": {
    get: {
      summary: "Jobs that exhausted their retries (redacted; retry with the worker's operations command)",
      security: "owner",
      query: S.FailedJobsQuerySchema,
      responses: { 200: S.FailedJobsResponseSchema },
    },
  },
  "/setup/usage": {
    get: {
      summary: "Model usage per day, and OpenAI's billed costs per day when OPENAI_ADMIN_KEY is set",
      security: "owner",
      query: S.UsageQuerySchema,
      responses: { 200: S.UsageResponseSchema },
    },
  },
  "/setup/wipe": { post: { summary: "Wipe all data", security: "owner", body: S.WipeRequestSchema, responses: { 200: S.OkSchema }, mutating: true } },
};

/**
 * zod-openapi renders manually registered components in input mode and adds
 * "<Name>Output" twins for responses. These domain schemas are only ever
 * responses, so keep a single component under the plain name.
 */
function collapseOutputComponents<T extends { components?: { schemas?: Record<string, unknown> } }>(doc: T): T {
  if (!doc.components?.schemas) return doc;
  let current = JSON.parse(JSON.stringify(doc)) as T;
  for (let changed = true; changed; ) {
    changed = false;
    const componentSchemas = current.components!.schemas!;
    for (const name of Object.keys(componentSchemas)) {
      const output = `${name}Output`;
      if (!(output in componentSchemas)) continue;
      const plainRef = `"#/components/schemas/${name}"`;
      const { [name]: _input, ...rest } = componentSchemas;
      const withoutInput = JSON.stringify({ ...current, components: { ...current.components, schemas: rest } });
      if (withoutInput.includes(plainRef)) continue; // the input form is still referenced
      current = JSON.parse(withoutInput.replaceAll(`"#/components/schemas/${output}"`, plainRef)) as T;
      const next = current.components!.schemas!;
      next[name] = next[output];
      delete next[output];
      changed = true;
      break;
    }
  }
  return current;
}

export function buildOpenApiDocument() {
  const paths: ZodOpenApiPathsObject = {};
  for (const [path, methods] of Object.entries(routes)) {
    paths[path] = Object.fromEntries(Object.entries(methods).map(([method, op]) => [method, operation(op)]));
  }
  return collapseOutputComponents(createDocument({
    openapi: "3.1.0",
    info: {
      title: "WABrain API",
      version: "1.0.0",
      description: "Self-hosted, read-only WhatsApp task and memory layer. See docs/API.md.",
    },
    components: {
      securitySchemes: {
        deviceToken: { type: "http", scheme: "bearer" },
        ownerSession: { type: "apiKey", in: "cookie", name: "__Host-wabrain_session" },
      },
      schemas: {
        Task: TaskSchema,
        TaskEvent: TaskEventSchema,
        TaskAction: TaskActionSchema,
        ReviewItem: ReviewItemSchema,
        Context: ContextSchema,
        Chat: ChatSchema,
        Person: PersonSchema,
        PersonFact: PersonFactSchema,
        Settings: SettingsSchema,
        MessageView: MessageViewSchema,
        NotificationEvent: NotificationEventSchema,
        NotificationsResponse: NotificationsResponseSchema,
        NotificationAckRequest: NotificationAckSchema,
        SyncResponse: S.SyncResponseSchema,
        TaskDetail: S.TaskDetailSchema,
        ProviderRoleInput: S.ProviderRoleInputSchema,
        ProviderRoleView: S.ProviderRoleViewSchema,
        ProviderTestResult: S.ProviderTestResultSchema,
        Error: ErrorResponseSchema,
      },
    },
    paths,
  }));
}
