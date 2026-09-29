import { useEffect, useState } from "preact/hooks";
import { PROVIDER_ROLES, describeError, type ProviderRole, type ProviderTestResult, type ProvidersState } from "../api";
import { Badge, Button, Card, Dot, Field, LoadError, Notice, PageHeader, Spinner, useAction, useApi, useLoad } from "../components/ui";
import {
  ENV_PREFIX,
  ROLE_TITLES,
  canClearKey,
  embeddingWarning,
  endpointKeyWarning,
  isDirty,
  keyState,
  limitHint,
  patchForm,
  toForms,
  toInput,
  validate,
  type Forms,
  type RoleForm,
} from "../providers-form";

const ROLE_INFO: Record<ProviderRole, { blurb: string; optional: boolean; placeholder: string }> = {
  text: {
    blurb: "Reads conversations and proposes tasks. Use a strong multilingual model.",
    optional: false,
    placeholder: "e.g. gpt-5 or claude-sonnet-4-5",
  },
  vision: {
    blurb: "Describes photos and reads text in them. Leave empty to reuse the text model.",
    optional: true,
    placeholder: "same as text when empty",
  },
  transcription: {
    blurb: "Transcribes voice messages. Test on real voice notes before committing.",
    optional: true,
    placeholder: "e.g. gpt-4o-transcribe or whisper-1",
  },
  embedding: {
    blurb: "Indexes messages for search. Vectors are stored with 1536 dimensions.",
    optional: true,
    placeholder: "text-embedding-3-large",
  },
};

const PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openai-compatible", label: "OpenAI-compatible (Ollama, OpenRouter…)" },
];

type RolePatch = Partial<Omit<RoleForm, "dirty" | "loaded">>;

function KeyStatus(props: { role: ProviderRole; form: RoleForm }) {
  const state = keyState(props.role, props.form);
  switch (state.kind) {
    case "stored":
      return <Badge tone="ok">Key set · saved encrypted</Badge>;
    case "env":
      return (
        <Badge tone="ok">
          Key set · from <code>{state.variable}</code>
        </Badge>
      );
    case "replace":
      return <Badge tone="warn">New key is saved when you save</Badge>;
    case "clear":
      return <Badge tone="warn">Key is removed when you save</Badge>;
    default:
      return <Badge tone="idle">No key</Badge>;
  }
}

function RoleBadge(props: { form: RoleForm; optional: boolean }) {
  const { form } = props;
  if (form.loaded?.source === "env" && !form.dirty) return <Badge tone="idle">From environment</Badge>;
  if (form.loaded && !form.dirty) return <Badge tone="ok">Configured</Badge>;
  if (form.dirty) return <Badge tone="warn">Unsaved</Badge>;
  return props.optional ? <Badge tone="idle">Optional</Badge> : <Badge tone="warn">Required</Badge>;
}

function TestLine(props: { result: ProviderTestResult }) {
  const { result } = props;
  const what = result.provider && result.model ? `${result.provider}/${result.model}` : null;
  return (
    <p class="test-result" role="status">
      <Dot tone={result.ok ? "ok" : "error"} label={result.ok ? "Passed" : "Failed"} />
      <span>
        {result.ok ? "Works" : result.message}
        {what ? <span class="muted"> · {what}</span> : null}
        {result.latencyMs !== null ? <span class="muted"> · {result.latencyMs} ms</span> : null}
      </span>
    </p>
  );
}

function RoleCard(props: {
  role: ProviderRole;
  form: RoleForm;
  encryptionConfigured: boolean;
  onChange: (patch: RolePatch) => void;
  onTest: () => void;
  testing: boolean;
  unsaved: boolean;
  result: ProviderTestResult | undefined;
}) {
  const { role, form } = props;
  const info = ROLE_INFO[role];
  const id = (field: string) => `${role}-${field}`;
  const endpointWarning = endpointKeyWarning(role, form);
  const dimensionWarning = role === "embedding" ? embeddingWarning(form) : null;
  const fromEnv = form.loaded?.source === "env";
  return (
    <Card title={ROLE_TITLES[role]} aside={<RoleBadge form={form} optional={info.optional} />}>
      <p class="muted">{info.blurb}</p>
      {fromEnv ? (
        <p class="hint">
          Set by the <code>{ENV_PREFIX[role]}_*</code> variables on the server. Saving here overrides them; choosing “Not set” goes back to them.
        </p>
      ) : null}
      <div class="grid-2">
        <Field id={id("provider")} label="Provider">
          <select id={id("provider")} value={form.provider} onChange={(event) => props.onChange({ provider: event.currentTarget.value })}>
            <option value="">{info.optional || fromEnv ? "Not set" : "Choose…"}</option>
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={provider.id === "anthropic" && (role === "transcription" || role === "embedding")}>
                {provider.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id={id("model")} label="Model">
          <input
            id={id("model")}
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder={info.placeholder}
            value={form.model}
            onInput={(event) => props.onChange({ model: event.currentTarget.value })}
          />
        </Field>
        <Field id={id("base")} label="Base URL" hint={form.provider === "openai-compatible" ? "Required, e.g. http://ollama:11434/v1" : "Optional proxy or gateway URL"}>
          <input
            id={id("base")}
            type="url"
            inputMode="url"
            autocomplete="off"
            spellcheck={false}
            placeholder="https://…"
            value={form.baseUrl}
            onInput={(event) => props.onChange({ baseUrl: event.currentTarget.value })}
          />
        </Field>
        <Field
          id={id("key")}
          label="API key"
          hint={
            <>
              <KeyStatus role={role} form={form} />{" "}
              {props.encryptionConfigured
                ? "Write-only: stored encrypted on the server and never shown again."
                : "Keys cannot be saved until APP_ENCRYPTION_KEY is set on the server."}
            </>
          }
        >
          <input
            id={id("key")}
            type="password"
            autocomplete="new-password"
            spellcheck={false}
            disabled={!props.encryptionConfigured}
            placeholder={keyState(role, { ...form, apiKey: "", clearKey: false }).kind === "none" ? "Paste the key" : "•••••••• (leave empty to keep)"}
            value={form.apiKey}
            onInput={(event) => props.onChange({ apiKey: event.currentTarget.value, clearKey: false })}
          />
        </Field>
        {role === "embedding" ? (
          <Field id={id("dims")} label="Dimensions" hint="Empty: 1536 for OpenAI, the model's native size otherwise. At most 1536.">
            <input
              id={id("dims")}
              type="number"
              inputMode="numeric"
              min={1}
              max={2000}
              value={form.dimensions}
              onInput={(event) => props.onChange({ dimensions: event.currentTarget.value })}
            />
          </Field>
        ) : null}
      </div>
      {endpointWarning ? <Notice tone="warn">{endpointWarning}</Notice> : null}
      {dimensionWarning ? <Notice tone="warn">{dimensionWarning}</Notice> : null}
      <details class="advanced">
        <summary>Limits{form.provider === "openai-compatible" ? " and compatibility" : ""}</summary>
        <div class="grid-2">
          <Field id={id("tokens")} label="Daily token limit" hint={limitHint(role, form, "dailyTokenLimit")}>
            <input
              id={id("tokens")}
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={form.loaded?.dailyTokenLimit != null ? String(form.loaded.dailyTokenLimit) : ""}
              value={form.dailyTokenLimit}
              onInput={(event) => props.onChange({ dailyTokenLimit: event.currentTarget.value })}
            />
          </Field>
          <Field id={id("calls")} label="Daily call limit" hint={limitHint(role, form, "dailyCallLimit")}>
            <input
              id={id("calls")}
              type="number"
              inputMode="numeric"
              min={0}
              placeholder={form.loaded?.dailyCallLimit != null ? String(form.loaded.dailyCallLimit) : ""}
              value={form.dailyCallLimit}
              onInput={(event) => props.onChange({ dailyCallLimit: event.currentTarget.value })}
            />
          </Field>
          {form.provider === "openai-compatible" && role !== "transcription" && role !== "embedding" ? (
            <Field id={id("structured")} label="Structured outputs" hint="Turn off for endpoints that do not support JSON-schema responses.">
              <select
                id={id("structured")}
                value={form.structuredOutputs}
                onChange={(event) => props.onChange({ structuredOutputs: event.currentTarget.value as RoleForm["structuredOutputs"] })}
              >
                <option value="">Default (on)</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </Field>
          ) : null}
        </div>
      </details>
      <div class="row">
        {canClearKey(form) ? (
          <label class="check">
            <input type="checkbox" checked={form.clearKey} onChange={(event) => props.onChange({ clearKey: event.currentTarget.checked, apiKey: "" })} />
            Remove the stored key
          </label>
        ) : null}
        <span class="spacer" />
        <Button
          variant="secondary"
          busy={props.testing}
          disabled={!form.loaded || props.unsaved}
          title={props.unsaved ? "Save first: tests use the saved settings" : undefined}
          onClick={props.onTest}
        >
          Test
        </Button>
      </div>
      {props.result ? <TestLine result={props.result} /> : null}
    </Card>
  );
}

export function Providers() {
  const api = useApi();
  const loaded = useLoad(() => api.providers(), []);
  const [state, setState] = useState<ProvidersState | null>(null);
  const [forms, setForms] = useState<Forms | null>(null);
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<Partial<Record<ProviderRole, ProviderTestResult>>>({});
  const [testingRole, setTestingRole] = useState<ProviderRole | "all" | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded.data) return;
    setState(loaded.data);
    setForms(toForms(loaded.data.roles));
  }, [loaded.data]);

  const dirty = forms ? isDirty(forms) : false;

  const save = useAction(async () => {
    if (!forms) return;
    const problem = validate(forms);
    if (problem) throw new Error(problem);
    const next = await api.saveProviders(toInput(forms));
    setState(next);
    setForms(toForms(next.roles));
    setResults({});
    setSaved(true);
  });

  const runTest = async (role: ProviderRole | "all") => {
    setTestingRole(role);
    setTestError(null);
    try {
      const rows = await api.testProviders(role === "all" ? undefined : [role]);
      setResults((previous) => {
        const next = { ...previous };
        for (const row of rows) next[row.role] = row;
        return next;
      });
      if (rows.length === 0) setTestError("The server returned no test results.");
    } catch (error) {
      setTestError(describeError(error));
    } finally {
      setTestingRole(null);
    }
  };

  const update = (role: ProviderRole, patch: RolePatch) => {
    setForms((previous) => (previous ? { ...previous, [role]: patchForm(previous[role], patch) } : previous));
    setSaved(false);
  };

  const anyConfigured = forms ? PROVIDER_ROLES.some((role) => forms[role].loaded) : false;

  return (
    <>
      <PageHeader kicker="AI providers" title="Models and keys">
        Choose a provider and model for each job. Keys stay on your server; the Android app never sees them. Messages are sent to the provider you
        choose, so pick one whose data policy you accept, or run a local model.
      </PageHeader>

      {loaded.loading && !loaded.data ? <Spinner /> : null}
      {loaded.error ? <LoadError error={loaded.error} feature="Provider settings" onRetry={loaded.reload} /> : null}

      {state && !state.encryptionConfigured ? (
        <Notice tone="warn" title="API keys cannot be saved">
          <code>APP_ENCRYPTION_KEY</code> is not set on the server, so it cannot encrypt keys entered here. Generate one with{" "}
          <code>openssl rand -base64 32</code>, set it for the API and the worker, and restart both. Until then, keys can only come from the{" "}
          <code>AI_*_API_KEY</code> variables.
        </Notice>
      ) : null}
      {state?.error ? (
        <Notice tone="warn" title="The worker cannot use this configuration">
          {state.error}
        </Notice>
      ) : null}

      {forms && state ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save.run();
          }}
        >
          {PROVIDER_ROLES.map((role) => (
            <RoleCard
              key={role}
              role={role}
              form={forms[role]}
              encryptionConfigured={state.encryptionConfigured}
              onChange={(patch) => update(role, patch)}
              onTest={() => void runTest(role)}
              testing={testingRole === role || testingRole === "all"}
              unsaved={dirty}
              result={results[role]}
            />
          ))}
          {testError ? <Notice tone="warn">{testError}</Notice> : null}
          {save.error ? <Notice tone="error">{save.error}</Notice> : null}
          {saved && !dirty ? <Notice tone="ok">Saved. The worker picks up the change on its next job. Run a test to confirm the keys work.</Notice> : null}
          <div class="sticky-actions">
            <Button variant="ghost" busy={testingRole === "all"} onClick={() => void runTest("all")} disabled={dirty || !anyConfigured}>
              Test all saved
            </Button>
            <Button variant="primary" type="submit" busy={save.busy} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
