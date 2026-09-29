/**
 * Writes owner-configured model provider settings (PUT /setup/providers). API keys arrive in plain
 * text, are encrypted here with AES-256-GCM (APP_ENCRYPTION_KEY, see crypto.ts) and are never read
 * back by this module: only the worker's provider registry decrypts them.
 */
import type { Db } from "../client.js";
import { encryptSecret } from "../crypto.js";
import { conflict } from "../errors.js";
import {
  PROVIDER_ROLES,
  deleteProviderSettings,
  listProviderSettings,
  upsertProviderSettings,
  type ProviderRole,
} from "../repos/provider-settings.js";

/** Additional authenticated data for a role's API key: a ciphertext only decrypts for its own role. */
export const providerApiKeyAad = (role: ProviderRole) => `provider:${role}:apiKey`;

export interface ProviderSettingsWrite {
  provider: string;
  model: string;
  baseUrl?: string | null;
  /** Plain text. Omitted keeps the stored key, null clears it, a string replaces it. */
  apiKey?: string | null;
  dimensions?: number | null;
  structuredOutputs?: boolean | null;
  dailyTokenLimit?: number | null;
  dailyCallLimit?: number | null;
}

/** Per role: settings to store, or null to remove the stored row (the role falls back to the env). */
export type ProviderSettingsChanges = Partial<Record<ProviderRole, ProviderSettingsWrite | null>>;

export interface ProviderSettingsChange {
  role: ProviderRole;
  action: "saved" | "removed";
  /** What happened to the stored key. Never the key itself. */
  apiKey: "set" | "cleared" | "kept" | "none";
}

/**
 * Applies `changes`. Run it inside a transaction when combined with other writes.
 *
 * A stored key is dropped when the provider or base URL changes and no new key is given, so a key is
 * never sent to an endpoint other than the one it was entered for. Throws a conflict when a key must
 * be stored but APP_ENCRYPTION_KEY is not configured.
 */
export async function saveProviderSettings(
  db: Db,
  encryptionKey: Buffer | null,
  changes: ProviderSettingsChanges,
): Promise<ProviderSettingsChange[]> {
  const needsKey = PROVIDER_ROLES.some((role) => typeof changes[role]?.apiKey === "string");
  if (needsKey && !encryptionKey) {
    throw conflict("APP_ENCRYPTION_KEY is not set, so the server cannot store API keys");
  }
  const existing = new Map((await listProviderSettings(db)).map((row) => [row.role, row]));
  const summary: ProviderSettingsChange[] = [];

  for (const role of PROVIDER_ROLES) {
    const change = changes[role];
    if (change === undefined) continue;
    const current = existing.get(role);
    if (change === null) {
      if (current) {
        await deleteProviderSettings(db, role);
        summary.push({ role, action: "removed", apiKey: current.apiKeyEncrypted ? "cleared" : "none" });
      }
      continue;
    }

    const baseUrl = change.baseUrl ?? null;
    const endpointChanged = Boolean(current && (current.provider !== change.provider || current.baseUrl !== baseUrl));
    let apiKeyEncrypted: string | null | undefined;
    let apiKey: ProviderSettingsChange["apiKey"];
    if (typeof change.apiKey === "string") {
      apiKeyEncrypted = encryptSecret(encryptionKey!, change.apiKey, providerApiKeyAad(role));
      apiKey = "set";
    } else if (change.apiKey === null || (endpointChanged && current?.apiKeyEncrypted)) {
      apiKeyEncrypted = null;
      apiKey = current?.apiKeyEncrypted ? "cleared" : "none";
    } else {
      apiKeyEncrypted = undefined;
      apiKey = current?.apiKeyEncrypted ? "kept" : "none";
    }

    await upsertProviderSettings(db, role, {
      provider: change.provider,
      model: change.model,
      baseUrl,
      apiKeyEncrypted,
      dimensions: change.dimensions ?? null,
      structuredOutputs: change.structuredOutputs ?? null,
      dailyTokenLimit: change.dailyTokenLimit ?? null,
      dailyCallLimit: change.dailyCallLimit ?? null,
    });
    summary.push({ role, action: "saved", apiKey });
  }
  return summary;
}
