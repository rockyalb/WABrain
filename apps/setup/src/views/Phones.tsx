import { useEffect, useRef, useState } from "preact/hooks";
import type { Device, PairingCode } from "../api";
import { QrCode } from "../components/QrCode";
import { Badge, Button, Card, CopyButton, LoadError, Notice, PageHeader, Spinner, formatDate, timeAgo, useAction, useApi, useLoad } from "../components/ui";
import { formatCountdown, parsePairingPayload, secondsLeft } from "../qr";

const POLL_MS = 3000;

export function PairingPanel(props: { code: PairingCode; knownDeviceIds: Set<string>; onClose: () => void; onRenew: () => void; onPaired: () => void }) {
  const api = useApi();
  const [left, setLeft] = useState(() => secondsLeft(props.code.expiresAt));
  const [paired, setPaired] = useState<Device | null>(null);
  const parsed = parsePairingPayload(props.code.qrPayload);
  const known = useRef(props.knownDeviceIds);

  useEffect(() => {
    setLeft(secondsLeft(props.code.expiresAt));
    const timer = setInterval(() => setLeft(secondsLeft(props.code.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [props.code.expiresAt]);

  // Watch for the phone completing the exchange so the owner gets confirmation here.
  useEffect(() => {
    if (paired || left === 0) return;
    const timer = setInterval(async () => {
      try {
        const { items } = await api.devices();
        const fresh = items.find((device) => !known.current.has(device.id));
        if (fresh) {
          setPaired(fresh);
          props.onPaired();
        }
      } catch {
        // Polling is best effort; the list refreshes when the panel closes.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [paired, left === 0]);

  const expired = left === 0;

  return (
    <div class="pairing" aria-live="polite">
      {paired ? (
        <div class="pairing-done">
          <div class="big-check" aria-hidden="true">✓</div>
          <h3>{paired.name} is connected</h3>
          <p>The phone now has its own revocable token. You can close this panel.</p>
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      ) : (
        <>
          <div class={`qr-frame ${expired ? "is-expired" : ""}`}>
            <QrCode payload={props.code.qrPayload} label="Pairing QR code for the WABrain Android app" />
            {expired ? (
              <div class="qr-overlay">
                <p>This code expired.</p>
                <Button variant="primary" onClick={props.onRenew}>
                  New code
                </Button>
              </div>
            ) : null}
          </div>
          <div class="pairing-side">
            <ol class="steps">
              <li>Open the WABrain app on the phone.</li>
              <li>
                Tap <b>Connect to server</b> and scan this code.
              </li>
              <li>This page confirms when the phone is paired.</li>
            </ol>
            <p class="countdown" role="timer" aria-label={`Code expires in ${formatCountdown(left)}`}>
              {expired ? (
                <Badge tone="error">Expired</Badge>
              ) : (
                <>
                  <span class="countdown-value">{formatCountdown(left)}</span> <span class="muted">left · single use</span>
                </>
              )}
            </p>
            {parsed ? (
              <p class="muted small">
                Server: <code>{parsed.server}</code>
              </p>
            ) : null}
            <div class="row">
              <CopyButton value={props.code.qrPayload} label="Copy pairing link" />
              <Button variant="ghost" onClick={props.onClose}>
                Cancel
              </Button>
            </div>
            <p class="hint">The link contains a one-time secret. Share it only with your own phone.</p>
          </div>
        </>
      )}
    </div>
  );
}

export function Phones() {
  const api = useApi();
  const devices = useLoad(() => api.devices(), []);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const create = useAction(async () => setCode(await api.createPairingCode()));
  const revoke = useAction(async (id: string) => {
    await api.revokeDevice(id);
    setConfirming(null);
    await devices.reload();
  });

  const items = devices.data?.items ?? [];
  const known = new Set(items.map((device) => device.id));

  return (
    <>
      <PageHeader
        kicker="Phones"
        title="Paired phones"
        actions={
          code ? null : (
            <Button variant="primary" busy={create.busy} disabled={!devices.data} onClick={() => void create.run()}>
              Pair a phone
            </Button>
          )
        }
      >
        Each phone gets its own token. Revoking one signs that phone out immediately.
      </PageHeader>

      {create.error ? <Notice tone="error">{create.error}</Notice> : null}

      {code ? (
        <Card title="Scan with the Android app">
          <PairingPanel
            code={code}
            knownDeviceIds={known}
            onClose={() => {
              setCode(null);
              void devices.reload();
            }}
            onRenew={() => void create.run()}
            onPaired={() => void devices.reload()}
          />
        </Card>
      ) : null}

      <Card title="Devices" aside={<span class="muted small">{items.length} active</span>}>
        {devices.loading && !devices.data ? <Spinner /> : null}
        {devices.error ? <LoadError error={devices.error} onRetry={devices.reload} /> : null}
        {devices.data && items.length === 0 ? <p class="empty">No phone is paired yet.</p> : null}
        {items.length > 0 ? (
          <ul class="list">
            {items.map((device) => (
              <li key={device.id} class="list-row">
                <div class="list-main">
                  <b>{device.name}</b>
                  <span class="muted small">
                    Paired {formatDate(device.createdAt)} · last seen {timeAgo(device.lastSeenAt)}
                  </span>
                </div>
                {confirming === device.id ? (
                  <div class="row">
                    <Button variant="danger" busy={revoke.busy} onClick={() => void revoke.run(device.id)}>
                      Revoke
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirming(device.id)} aria-label={`Revoke ${device.name}`}>
                    Revoke…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {revoke.error ? <Notice tone="error">{revoke.error}</Notice> : null}
      </Card>
    </>
  );
}

