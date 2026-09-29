/**
 * Form state for the AI providers screen, kept free of UI code so it can be tested.
 *
 * PUT /setup/providers replaces every field of a role it names (except the key), so a role the
 * owner edited is sent in full, with the loaded values for fields the page does not show; a role
 * the owner did not touch is left out of the body and stays exactly as it is.
 */
import { PROVIDER_ROLES, type ProviderRole, type ProviderRoleInput, type ProviderRoleView, type ProvidersInput, type ProvidersView } from "./api";

/** Vectors are stored in 1536 dimensions; models with more are refused by the worker. */
export const MAX_EMBEDDING_DIMENSIONS = 1536;
/** pgvector's HNSW limit, which the API also enforces. */
const API_MAX_DIMENSIONS = 2000;

export const ROLE_TITLES: Record<ProviderRole, string> = {
  text: "Text analysis",
  vision: "Images",
  transcription: "Voice notes",
  embedding: "Search embeddings",
};

export const ENV_PREFIX: Record<ProviderRole, string> = {
  text: "AI_TEXT",
  vision: "AI_VISION",
  transcription: "AI_TRANSCRIPTION",
  embedding: "AI_EMBEDDING",
};

export interface RoleForm {
  provider: string;
  model: string;
  baseUrl: string;
  /** A new key typed by the owner; empty keeps the current one. */
  apiKey: string;
  clearKey: boolean;
  dimensions: string;
  /** "" = the provider default (structured outputs on), "true", "false". */
  structuredOutputs: "" | "true" | "false";
  dailyTokenLimit: string;
  dailyCallLimit: string;
  /** The owner changed something in this role since it was loaded. */
  dirty: boolean;
  /** What the server reported for this role, or null when the role is not configured. */
  loaded: ProviderRoleView | null;
}

export type Forms = Record<ProviderRole, RoleForm>;

const numberText = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));

export function toForm(view: ProviderRoleView | null): RoleForm {
  return {
    provider: view?.provider ?? "",
    model: view?.model ?? "",
    baseUrl: view?.baseUrl ?? "",
    apiKey: "",
    clearKey: false,
    dimensions: numberText(view?.dimensions),
    structuredOutputs: view?.structuredOutputs === true ? "true" : view?.structuredOutputs === false ? "false" : "",
    // Only the saved override: an inherited environment limit stays blank, so editing another field
    // does not turn it into a database value that ignores later environment changes.
    dailyTokenLimit: numberText(view?.storedDailyTokenLimit),
    dailyCallLimit: numberText(view?.storedDailyCallLimit),
    dirty: false,
    loaded: view,
  };
}

export function toForms(view: ProvidersView): Forms {
  const forms = {} as Forms;
  for (const role of PROVIDER_ROLES) forms[role] = toForm(view[role]);
  return forms;
}

export function patchForm(form: RoleForm, patch: Partial<Omit<RoleForm, "dirty" | "loaded">>): RoleForm {
  return { ...form, ...patch, dirty: true };
}

export const isDirty = (forms: Forms): boolean => PROVIDER_ROLES.some((role) => forms[role].dirty);

const optionalNumber = (text: string): number | null => (text.trim() === "" ? null : Number(text.trim()));
const normalizedBaseUrl = (form: RoleForm): string | null => form.baseUrl.trim() || null;

/** Builds the PUT body: only edited roles, each with every field (the loaded values where untouched). */
export function toInput(forms: Forms): ProvidersInput {
  const input: ProvidersInput = {};
  for (const role of PROVIDER_ROLES) {
    const form = forms[role];
    if (!form.dirty) continue;
    if (!form.provider || !form.model.trim()) {
      // Removes the saved settings; the role falls back to the AI_* variables, if any.
      input[role] = null;
      continue;
    }
    const entry: ProviderRoleInput = {
      provider: form.provider,
      model: form.model.trim(),
      baseUrl: normalizedBaseUrl(form),
      dimensions: role === "embedding" ? optionalNumber(form.dimensions) : null,
      structuredOutputs: form.structuredOutputs === "" ? null : form.structuredOutputs === "true",
      dailyTokenLimit: optionalNumber(form.dailyTokenLimit),
      dailyCallLimit: optionalNumber(form.dailyCallLimit),
    };
    if (form.apiKey.trim()) entry.apiKey = form.apiKey.trim();
    else if (form.clearKey) entry.apiKey = null;
    input[role] = entry;
  }
  return input;
}

const isWholeNumber = (text: string, min: number, max: number) => {
  if (text.trim() === "") return true;
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= min && value <= max;
};

/** The first problem that would make the server reject the body, in words, or null. */
export function validate(forms: Forms): string | null {
  const text = forms.text;
  if (text.dirty && !text.provider && !text.model.trim()) return "Text analysis needs a provider and a model.";
  for (const role of PROVIDER_ROLES) {
    const form = forms[role];
    if (!form.dirty) continue;
    const title = ROLE_TITLES[role];
    if (form.provider && !form.model.trim()) return `${title}: enter a model name.`;
    if (!form.provider && form.model.trim()) return `${title}: choose a provider.`;
    if (!form.provider) continue;
    const baseUrl = form.baseUrl.trim();
    if (form.provider === "openai-compatible" && !baseUrl) return `${title}: OpenAI-compatible endpoints need a base URL.`;
    if (baseUrl && !/^https?:\/\/[^\s/]+/.test(baseUrl)) return `${title}: the base URL must start with http:// or https://.`;
    if ((role === "transcription" || role === "embedding") && form.provider === "anthropic") return `${title}: Anthropic has no ${role} models.`;
    if (role === "embedding" && !isWholeNumber(form.dimensions, 1, API_MAX_DIMENSIONS)) return `${title}: dimensions must be a whole number from 1 to ${API_MAX_DIMENSIONS}.`;
    if (!isWholeNumber(form.dailyTokenLimit, 0, 1_000_000_000)) return `${title}: the daily token limit must be a whole number.`;
    if (!isWholeNumber(form.dailyCallLimit, 0, 1_000_000_000)) return `${title}: the daily call limit must be a whole number.`;
  }
  return null;
}

export type KeyState =
  | { kind: "none" }
  | { kind: "stored" }
  | { kind: "env"; variable: string }
  | { kind: "replace" }
  | { kind: "clear" };

/** What happens to this role's key when the form is saved as it is. */
export function keyState(role: ProviderRole, form: RoleForm): KeyState {
  if (form.apiKey.trim()) return { kind: "replace" };
  if (form.clearKey) return { kind: "clear" };
  const loaded = form.loaded;
  if (!loaded?.hasApiKey || endpointChanged(form)) return { kind: "none" };
  return loaded.apiKeySource === "env" ? { kind: "env", variable: `${ENV_PREFIX[role]}_API_KEY` } : { kind: "stored" };
}

/** The provider or base URL differs from what was loaded. */
export function endpointChanged(form: RoleForm): boolean {
  const loaded = form.loaded;
  if (!loaded || !form.provider) return false;
  return loaded.provider !== form.provider || (loaded.baseUrl ?? null) !== normalizedBaseUrl(form);
}

/**
 * The server clears a stored key when the provider or base URL changes without a new key, so the
 * key is never sent to a different endpoint. An environment key applies only to its own endpoint.
 */
export function endpointKeyWarning(role: ProviderRole, form: RoleForm): string | null {
  if (!form.dirty || form.apiKey.trim() || !endpointChanged(form) || !form.loaded?.hasApiKey) return null;
  if (form.loaded.apiKeySource === "env") {
    return `The key from ${ENV_PREFIX[role]}_API_KEY is used only with the provider and base URL set in the environment. Enter a key for the new endpoint.`;
  }
  return "Changing the provider or base URL removes the stored key when you save, so it is never sent to a different endpoint. Enter the key for the new endpoint.";
}

/** Warns before saving an embedding setup the worker will refuse (vectors are stored in 1536 dimensions). */
export function embeddingWarning(form: RoleForm): string | null {
  if (!form.provider) return null;
  const dimensions = optionalNumber(form.dimensions);
  if (dimensions !== null && Number.isFinite(dimensions) && dimensions > MAX_EMBEDDING_DIMENSIONS) {
    return `Search stores vectors with at most ${MAX_EMBEDDING_DIMENSIONS} dimensions. With ${dimensions}, embedding is refused and search falls back to text matching. Use ${MAX_EMBEDDING_DIMENSIONS} or fewer.`;
  }
  if (dimensions === null && form.provider === "openai-compatible") {
    const large = /text-embedding-3-large/i.test(form.model);
    return large
      ? `text-embedding-3-large returns 3072 dimensions unless you ask for fewer. Set Dimensions to ${MAX_EMBEDDING_DIMENSIONS}, or embedding is refused.`
      : `Without Dimensions the model's native size is used. Models with more than ${MAX_EMBEDDING_DIMENSIONS} dimensions are refused; smaller ones (bge-m3: 1024) work.`;
  }
  return null;
}

export type LimitKind = "dailyTokenLimit" | "dailyCallLimit";

const LIMIT_ENV: Record<LimitKind, string> = { dailyTokenLimit: "DAILY_TOKEN_LIMIT", dailyCallLimit: "DAILY_CALL_LIMIT" };

/** What an empty limit field means: the environment's limit for the role, if any, or no limit. */
export function limitHint(role: ProviderRole, form: RoleForm, kind: LimitKind): string {
  const variable = `${ENV_PREFIX[role]}_${LIMIT_ENV[kind]}`;
  const typed = form[kind].trim() !== "";
  const loaded = form.loaded;
  const stored = kind === "dailyTokenLimit" ? loaded?.storedDailyTokenLimit : loaded?.storedDailyCallLimit;
  // The effective value came from the environment only when nothing was saved for it.
  const inherited = stored === null || stored === undefined ? (loaded?.[kind] ?? null) : null;
  if (inherited !== null) {
    return typed
      ? `Overrides ${variable} (${inherited}) for this role. Empty: use ${variable}.`
      : `Empty: uses ${variable} (${inherited}) and follows later changes to it.`;
  }
  return `Empty: uses ${variable} when it is set, otherwise no limit.`;
}

/** The Remove-key option only makes sense for a key saved on this page. */
export const canClearKey = (form: RoleForm): boolean => form.loaded?.apiKeySource === "db" && !endpointChanged(form);
