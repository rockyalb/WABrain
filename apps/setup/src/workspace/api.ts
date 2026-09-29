import type { Api } from "../api";
import type { Chat, Context, MessageView, Person, ReviewItem, Settings, Snapshot, Task, TaskDetail, AskResponse } from "./model";

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "kind" | "contextId" | "dueAt" | "dueHasTime">>;
export type NewTask = TaskPatch & { title: string; kind: Task["kind"]; chatId?: string | null; personId?: string | null };

const id = encodeURIComponent;

export function workspaceApi(api: Api) {
  const call = api.request;
  return {
    snapshot: () => call<Snapshot>("GET", "/web/sync"),
    task: (taskId: string) => call<TaskDetail>("GET", `/web/tasks/${id(taskId)}`),
    createTask: (draft: NewTask) => call<Task>("POST", "/web/tasks", draft),
    updateTask: (taskId: string, patch: TaskPatch) => call<Task>("PATCH", `/web/tasks/${id(taskId)}`, patch),
    taskStatus: (taskId: string, action: "complete" | "reopen" | "cancel") => call<Task>("POST", `/web/tasks/${id(taskId)}/${action}`, {}),
    undo: (eventId: string) => call<Task>("POST", `/web/task-events/${id(eventId)}/undo`, {}),
    decide: (reviewId: string, accept: boolean, edits?: TaskPatch, closeAs?: "done" | "cancelled") => call<{ reviewItem: ReviewItem; task?: Task | null }>("POST", `/web/review/${id(reviewId)}/${accept ? "accept" : "reject"}`, accept ? { edits, closeAs } : {}),
    person: (personId: string) => call<Person>("GET", `/web/people/${id(personId)}`),
    updatePerson: (personId: string, patch: Partial<Pick<Person, "displayName" | "defaultContextId">>) => call<Person>("PATCH", `/web/people/${id(personId)}`, patch),
    addFact: (personId: string, key: Person["facts"][number]["key"], value: string) => call<Person["facts"][number]>("POST", `/web/people/${id(personId)}/facts`, { key, value }),
    updateFact: (personId: string, factId: string, patch: { value?: string; verified?: boolean }) => call<Person["facts"][number]>("PATCH", `/web/people/${id(personId)}/facts/${id(factId)}`, patch),
    deleteFact: (personId: string, factId: string) => call<void>("DELETE", `/web/people/${id(personId)}/facts/${id(factId)}`),
    factSources: (personId: string, factId: string) => call<{ items: MessageView[] }>("GET", `/web/people/${id(personId)}/facts/${id(factId)}/sources`),
    deletePersonData: (personId: string) => call<void>("DELETE", `/web/people/${id(personId)}/data`),
    updateChat: (chatId: string, patch: Partial<Pick<Chat, "mode" | "defaultContextId" | "contextConfirmed" | "autoCreate" | "minimumAutoConfidence" | "aliases">>) => call<Chat>("PATCH", `/web/chats/${id(chatId)}`, patch),
    deleteChatData: (chatId: string) => call<void>("DELETE", `/web/chats/${id(chatId)}/data`),
    messages: (chatId: string, around?: string) => call<{ items: MessageView[] }>("GET", `/web/chats/${id(chatId)}/messages?before=50&after=50${around ? `&around=${id(around)}` : ""}`),
    ask: (question: string, filters: { personId: string | null; contextId: string | null; from: string | null; to: string | null }) => call<AskResponse>("POST", "/web/ask", { question, ...filters }),
    settings: () => call<Settings>("GET", "/web/settings"),
    updateSettings: (patch: Partial<Settings>) => call<Settings>("PATCH", "/web/settings", patch),
    createContext: (name: string, color: string | null) => call<Context>("POST", "/web/contexts", { name, color }),
    updateContext: (contextId: string, patch: Partial<Context>) => call<Context>("PATCH", `/web/contexts/${id(contextId)}`, patch),
    deleteContext: (contextId: string, reassignTo?: string) => call<void>("DELETE", `/web/contexts/${id(contextId)}${reassignTo ? `?reassignTo=${id(reassignTo)}` : ""}`),
    vapidKey: () => call<{ publicKey: string }>("GET", "/web/push/public-key"),
    savePush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) => call<void>("POST", "/web/push-endpoints", { endpoint: subscription.endpoint, ...subscription.keys }),
    deletePush: () => call<void>("DELETE", "/web/push-endpoints"),
    notifications: () => call<{ items: Array<{ id: string; payload: Record<string, unknown> }> }>("GET", "/web/notifications"),
    acknowledge: (ids: string[]) => call<{ ok: boolean }>("POST", "/web/notifications/ack", { ids }),
  };
}
