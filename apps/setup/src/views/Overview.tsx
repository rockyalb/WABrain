import type { ComponentChildren } from "preact";
import type { OpenWaStatus, SetupStatus } from "../api";
import { Button, Dot, LoadError, PageHeader, Spinner, formatDate, timeAgo, useApi, useLoad, type Tone } from "../components/ui";
import { connectionSummary } from "../openwa";
import type { Section } from "../sections";

function Tile(props: { label: string; tone: Tone; value: ComponentChildren; detail?: ComponentChildren; href?: Section }) {
  const body = (
    <>
      <span class="tile-label">
        <Dot tone={props.tone} /> {props.label}
      </span>
      <span class="tile-value">{props.value}</span>
      {props.detail ? <span class="tile-detail">{props.detail}</span> : null}
    </>
  );
  return props.href ? (
    <a class="tile" href={`#/${props.href}`}>
      {body}
    </a>
  ) : (
    <div class="tile">{body}</div>
  );
}

const money = (value: number) => value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** Renders whatever spending summary the server reports (field names vary by version). */
function Spending(props: { spending: Record<string, unknown> }) {
  const numeric = Object.entries(props.spending).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  const spent = props.spending.spentUsd ?? props.spending.monthUsd ?? props.spending.todayUsd;
  const budget = props.spending.budgetUsd ?? props.spending.monthlyBudgetUsd ?? props.spending.dailyBudgetUsd;
  if (typeof spent === "number" && typeof budget === "number" && budget > 0) {
    const ratio = Math.min(1, spent / budget);
    const tone: Tone = ratio >= 1 ? "error" : ratio >= 0.8 ? "warn" : "ok";
    return (
      <Tile
        label="Model spending"
        tone={tone}
        value={`${money(spent)} of ${money(budget)}`}
        detail={
          <span class="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label="Budget used">
            <span class={`meter-fill meter-${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
          </span>
        }
      />
    );
  }
  if (numeric.length === 0) return null;
  return (
    <Tile
      label="Model spending"
      tone="idle"
      value={numeric[0]![0].toLowerCase().includes("usd") ? money(numeric[0]![1]) : String(numeric[0]![1])}
      detail={numeric
        .slice(1, 4)
        .map(([key, value]) => `${key}: ${key.toLowerCase().includes("usd") ? money(value) : value}`)
        .join(" · ")}
    />
  );
}

/**
 * The OpenWA tile. /setup/status reports only `configured`, so the live state comes from
 * GET /setup/openwa/status when it answered (`openwa`), and from `status.openwa` otherwise.
 */
function openWaTile(status: SetupStatus, openwa: OpenWaStatus | null): { tone: Tone; value: string; detail: string } {
  if (!status.openwa.configured) return { tone: "warn", value: "Not configured", detail: "Set OPENWA_BASE_URL and OPENWA_READ_API_KEY" };
  if (openwa) {
    const summary = connectionSummary(openwa);
    const account = openwa.session?.pushName ?? openwa.session?.phone;
    return {
      tone: summary.tone,
      value: summary.label,
      detail: openwa.error ? openwa.error.message : account ? `Linked as ${account} · read-only key` : "Read-only key in use",
    };
  }
  return {
    tone: status.openwa.ok === false ? "error" : "idle",
    value: status.openwa.status ?? "Configured",
    detail: "Open for the live connection state",
  };
}

export function StatusTiles(props: { status: SetupStatus; openwa?: OpenWaStatus | null }) {
  const { status } = props;
  const openwa = openWaTile(status, props.openwa ?? null);
  const providers = status.providers?.configured ?? [];
  return (
    <div class="tiles">
      <Tile label="WhatsApp (OpenWA)" tone={openwa.tone} value={openwa.value} detail={openwa.detail} href="whatsapp" />
      <Tile label="Database" tone={status.database.ok ? "ok" : "error"} value={status.database.ok ? "Healthy" : "Unreachable"} />
      <Tile
        label="Worker"
        tone={status.worker.ok ? "ok" : "error"}
        value={status.worker.ok ? "Running" : "Not running"}
        detail={`Last heartbeat ${timeAgo(status.worker.lastSeenAt)}`}
      />
      <Tile
        label="AI providers"
        tone={providers.length === 0 ? "warn" : providers.includes("text") ? "ok" : "warn"}
        value={providers.length === 0 ? "None configured" : `${providers.length} of 4 roles`}
        detail={providers.length ? providers.join(", ") : "Text analysis needs a provider"}
        href="providers"
      />
      <Tile
        label="Trial"
        tone={status.trial.active ? "warn" : "ok"}
        value={status.trial.active ? "Every task goes to Review" : "Auto-create enabled"}
        detail={status.trial.active ? `Ends ${formatDate(status.trial.endsAt)}` : `Ended ${formatDate(status.trial.endsAt)}`}
        href="policy"
      />
      <Tile
        label="Phones"
        tone={status.devices.count > 0 ? "ok" : "idle"}
        value={status.devices.count === 1 ? "1 paired" : `${status.devices.count} paired`}
        detail={status.devices.count ? "Manage devices" : "Pair the Android app"}
        href="phones"
      />
      {status.spending && typeof status.spending === "object" ? <Spending spending={status.spending} /> : null}
    </div>
  );
}

export function Overview() {
  const api = useApi();
  const status = useLoad(() => api.status(), []);
  // Best effort: the tile falls back to /setup/status when this fails.
  const openwa = useLoad(() => api.openWaStatus(), []);
  const reload = () => {
    void status.reload();
    void openwa.reload();
  };
  return (
    <>
      <PageHeader
        kicker="Overview"
        title="Server status"
        actions={
          <Button variant="ghost" busy={status.loading && Boolean(status.data)} onClick={reload}>
            Refresh
          </Button>
        }
      >
        WABrain reads your WhatsApp through OpenWA and never writes to it. This page shows whether every part is healthy.
      </PageHeader>
      {status.loading && !status.data ? <Spinner /> : null}
      {status.error ? <LoadError error={status.error} onRetry={status.reload} /> : null}
      {status.data ? <StatusTiles status={status.data} openwa={openwa.error ? null : (openwa.data ?? null)} /> : null}
    </>
  );
}
