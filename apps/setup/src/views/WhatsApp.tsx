import { useState } from "preact/hooks";
import type { OpenWaStatus, OpenWaTestResult } from "../api";
import { Badge, Button, Card, CopyButton, Dot, LoadError, Notice, PageHeader, Spinner, formatDate, timeAgo, useAction, useApi, useLoad } from "../components/ui";
import { checkTone, connectionSummary, isLoopbackUrl, problemHint, testSummary, tunnelCommand } from "../openwa";

function TunnelHint(props: { url: string | null }) {
  return (
    <Notice tone="info" title="The dashboard is only reachable from the server">
      <p>
        Open an SSH tunnel from your computer first, keep it open while you pair, then use the link:
      </p>
      <div class="copy-line">
        <code>{tunnelCommand(props.url)}</code>
        <CopyButton value={tunnelCommand(props.url)} />
      </div>
      <p class="hint">Keep the dashboard private: it signs in with the OpenWA admin key.</p>
    </Notice>
  );
}

function PairingCard(props: { status: OpenWaStatus; refreshKey: number }) {
  const api = useApi();
  const pairing = useLoad(() => api.openWaPairing(), [props.refreshKey]);
  const info = pairing.data;
  const dashboard = info ? info.dashboardUrl : props.status.dashboardUrl;
  const sessionId = info ? info.sessionId : props.status.sessionId;
  return (
    <Card title="Link WhatsApp in OpenWA" aside={<Badge tone="warn">Not linked</Badge>}>
      <p>
        Pairing happens in the OpenWA dashboard, not here: OpenWA shows the WhatsApp QR code only to operator keys, which can also send messages, and
        WABrain deliberately holds only a read-only key.
      </p>
      {pairing.loading && !info ? <Spinner label="Asking OpenWA…" /> : null}
      {pairing.error ? <LoadError error={pairing.error} onRetry={pairing.reload} /> : null}
      {info ? <p class="muted">{info.message}</p> : null}
      {dashboard ? (
        <div class="row">
          <a class="btn btn-primary" href={dashboard} target="_blank" rel="noopener noreferrer">
            <span>Open the OpenWA dashboard</span>
          </a>
          <code class="small">{dashboard}</code>
        </div>
      ) : (
        <Notice tone="warn" title="No dashboard link">
          Set <code>OPENWA_DASHBOARD_URL</code> on the API to link to the OpenWA dashboard from here. In the compose bundle the dashboard listens on{" "}
          <code>127.0.0.1:2785</code> of the server.
        </Notice>
      )}
      {!dashboard || isLoopbackUrl(dashboard) ? <TunnelHint url={dashboard} /> : null}
      <ol class="steps">
        <li>Open the dashboard and sign in with the OpenWA admin key.</li>
        <li>
          Open the session{sessionId ? (
            <>
              {" "}
              <code>{sessionId}</code>
            </>
          ) : null}
          . Make sure the engine is <b>Baileys</b>, then start it.
        </li>
        <li>
          Scan its QR code on your phone under <b>WhatsApp → Settings → Linked devices → Link a device</b>.
        </li>
        <li>Come back here and press Refresh. The state should read “Connected”.</li>
      </ol>
      <Notice tone="warn" title="Shared session">
        If this OpenWA session is also used by another app, re-pairing it affects that app too.
      </Notice>
    </Card>
  );
}

function TestResults(props: { result: OpenWaTestResult }) {
  const summary = testSummary(props.result.checks);
  return (
    <>
      <Notice tone={summary.tone}>{summary.text}</Notice>
      <ul class="checks">
        {props.result.checks.map((check) => {
          const tone = checkTone(check);
          return (
            <li key={check.id}>
              <Dot tone={tone} label={tone === "ok" ? "Passed" : tone === "warn" ? "Warning" : "Failed"} />
              <div>
                <b>{check.label}</b>
                <span class={`small ${tone === "error" ? "text-error" : "muted"}`}>{check.detail}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function SessionChoices(props: { sessions: NonNullable<OpenWaStatus["sessions"]> }) {
  if (props.sessions.length === 0) return null;
  return (
    <>
      <p>Sessions this key can see:</p>
      <ul class="list">
        {props.sessions.map((session) => (
          <li key={session.id} class="list-row">
            <div class="list-main">
              <b>{session.name ?? "Unnamed session"}</b>
              <code class="small">{session.id}</code>
            </div>
            <div class="row">
              <span class="muted small">{session.status}</span>
              <CopyButton value={session.id} label="Copy id" />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function SessionCard(props: { data: OpenWaStatus; onTest: () => void; testing: boolean; testError: string | null; result: OpenWaTestResult | null }) {
  const { data } = props;
  const summary = connectionSummary(data);
  const session = data.session;
  const hint = problemHint(data.error?.code);
  return (
    <Card
      title="Session"
      aside={
        <span class="state">
          <Dot tone={summary.tone} /> {summary.label}
        </span>
      }
    >
      {data.error ? (
        <Notice tone={data.error.code === "no_session_id" ? "warn" : "error"} title={data.error.message}>
          {hint ?? "Check the OpenWA settings on the server."}
        </Notice>
      ) : null}
      <SessionChoices sessions={data.sessions ?? []} />
      {session ? (
        <dl class="facts">
          <div>
            <dt>Account</dt>
            <dd>{session.pushName ?? "—"}</dd>
          </div>
          <div>
            <dt>Number</dt>
            <dd>{session.phone ?? "—"}</dd>
          </div>
          <div>
            <dt>Connected</dt>
            <dd>{timeAgo(session.connectedAt)}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{timeAgo(session.lastActive)}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>
              {session.name ? `${session.name} · ` : ""}
              <code class="small">{session.id ?? data.sessionId}</code>
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{session.engineLoaded === false ? "Not loaded" : session.engineLoaded ? "Loaded" : "—"}</dd>
          </div>
        </dl>
      ) : null}
      {session?.restriction ? (
        <Notice tone="error" title="WhatsApp restricted this account">
          {session.restriction.kind}
          {session.restriction.code ? ` (${session.restriction.code})` : ""}
          {session.restriction.expiresAt ? `, until ${formatDate(session.restriction.expiresAt)}` : ""}. Wait for it to end before pairing again.
        </Notice>
      ) : null}
      {session?.lastError && session.status !== "ready" ? <Notice tone="warn" title="OpenWA's last error">{session.lastError}</Notice> : null}
      <div class="row">
        <Button variant="primary" busy={props.testing} disabled={!data.sessionId} onClick={props.onTest} title={data.sessionId ? undefined : "Set OPENWA_SESSION_ID first"}>
          Test read access
        </Button>
        <span class="muted small">Only GET requests. Nothing is sent to WhatsApp.</span>
      </div>
      {props.testError ? <Notice tone="error">{props.testError}</Notice> : null}
      {props.result ? <TestResults result={props.result} /> : null}
    </Card>
  );
}

export function WhatsApp() {
  const api = useApi();
  const [refreshKey, setRefreshKey] = useState(0);
  const status = useLoad(() => api.openWaStatus(), []);
  const [result, setResult] = useState<OpenWaTestResult | null>(null);
  const test = useAction(async () => setResult(await api.openWaTest()));
  const data = status.data;
  const refresh = () => {
    setRefreshKey((key) => key + 1);
    void status.reload();
  };

  return (
    <>
      <PageHeader
        kicker="WhatsApp"
        title="WhatsApp connection"
        actions={
          <Button variant="ghost" busy={status.loading && Boolean(data)} onClick={refresh}>
            Refresh
          </Button>
        }
      >
        OpenWA holds the linked-device session. WABrain only reads messages it forwards and never sends, reacts, or marks anything as read.
      </PageHeader>

      {status.loading && !data ? <Spinner /> : null}
      {status.error ? <LoadError error={status.error} feature="The WhatsApp connection check" onRetry={status.reload} /> : null}

      {data && !data.configured ? (
        <Notice tone="warn" title="OpenWA is not configured">
          Set <code>OPENWA_BASE_URL</code>, <code>OPENWA_SESSION_ID</code>, and a read-only <code>OPENWA_READ_API_KEY</code> (a <b>viewer</b> key scoped to
          the session) for the API and the worker, then restart them. See docs/OPENWA_SETUP.md.
        </Notice>
      ) : null}

      {data && data.configured ? (
        <SessionCard data={data} onTest={() => void test.run()} testing={test.busy} testError={test.error} result={result} />
      ) : null}

      {data && data.configured && data.session && data.session.status !== "ready" ? (
        <PairingCard status={data} refreshKey={refreshKey} />
      ) : null}

      {data ? (
        <Card title="Signed webhook" aside={<Badge tone="idle">One-time step</Badge>}>
          <p>
            OpenWA pushes <code>message.received</code> and <code>message.sent</code> to this address, signed with <code>OPENWA_WEBHOOK_SECRET</code>:
          </p>
          <div class="copy-line">
            <code>{data.webhookUrl}</code>
            <CopyButton value={data.webhookUrl} />
          </div>
          <p class="hint">
            Register it once with <code>deploy/register-webhook.sh</code>, which uses a short-lived OpenWA operator key and deletes it again. In the compose
            bundle OpenWA reaches the API on the internal network instead. See docs/DEPLOY.md.
          </p>
        </Card>
      ) : null}

      <Notice tone="info" title="Account risk">
        OpenWA is an unofficial WhatsApp client. WhatsApp may restrict or ban accounts that use unofficial clients. Use it only with your own account.
      </Notice>
    </>
  );
}
