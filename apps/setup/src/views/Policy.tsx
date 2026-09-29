import { useEffect, useState } from "preact/hooks";
import type { AutoCreateStatus } from "../api";
import { Button, Card, Field, LoadError, Notice, PageHeader, Spinner, formatDate, useAction, useApi, useLoad } from "../components/ui";

const DEFAULT_THRESHOLD = 0.85;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Why new tasks are, or are not yet, created without Review. */
function AutoCreateSummary({ status }: { status: AutoCreateStatus | undefined }) {
  if (!status) return null;
  const { calibration, required, profile } = status;
  const model = profile ? ` (${profile.model}, prompt ${profile.promptVersion})` : "";
  if (status.state === "active" && calibration.effectiveThreshold !== null) {
    return (
      <p class="muted">
        Creating tasks automatically at {percent(calibration.effectiveThreshold)} confidence or more{model}, calibrated from {calibration.decisions} of your
        Review decisions.
      </p>
    );
  }
  if (status.state === "trial") {
    return (
      <p class="muted">
        Every new task waits in Review during the trial. Decisions so far for the current model: {calibration.decisions} of {required.decisions} needed.
      </p>
    );
  }
  const why =
    calibration.reason === "no_reliable_threshold"
      ? `no confidence level yet where at least ${percent(required.precision)} of proposals were accepted with ${required.uneditedAcceptedAtThreshold} accepted unedited`
      : `${calibration.decisions} of ${required.decisions} decisions so far, with at least ${required.accepted} accepted and ${required.rejected} rejected needed (now ${calibration.accepted} and ${calibration.rejected})`;
  return (
    <p class="muted">
      The trial is over, but new tasks still wait in Review until your decisions calibrate the current model{model}: {why}. Changing the model or prompt
      starts a new calibration.
    </p>
  );
}

export function Policy() {
  const api = useApi();
  const status = useLoad(() => api.status(), []);
  const [trialDays, setTrialDays] = useState("7");
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const data = status.data;
    if (!data) return;
    setTrialDays(String(data.policy?.trialDays ?? data.trial.days));
    if (typeof data.policy?.autoCreateThreshold === "number") setThreshold(data.policy.autoCreateThreshold);
  }, [status.data]);

  const save = useAction(async () => {
    const days = Number(trialDays);
    if (!Number.isInteger(days) || days < 0 || days > 90) throw new Error("Trial days must be a whole number from 0 to 90.");
    await api.updatePolicy({ trialDays: days, autoCreateThreshold: Math.round(threshold * 100) / 100 });
    setSaved(true);
    await status.reload();
  });

  const trial = status.data?.trial;

  return (
    <>
      <PageHeader kicker="Policy" title="When tasks are created automatically">
        During the trial every proposed task waits in Review. Your approvals and rejections become the evaluation set used to tune the threshold below.
      </PageHeader>
      {status.loading && !status.data ? <Spinner /> : null}
      {status.error ? <LoadError error={status.error} onRetry={status.reload} /> : null}
      {status.data ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save.run();
          }}
        >
          <Card title="Trial period">
            {trial ? (
              <p class="muted">
                {trial.active ? "The trial is running" : "The trial has ended"}: started {formatDate(trial.startedAt)}, {trial.active ? "ends" : "ended"}{" "}
                {formatDate(trial.endsAt)}.
              </p>
            ) : null}
            <Field id="trial-days" label="Trial length in days" hint="0 ends the trial now. The start date does not change.">
              <input
                id="trial-days"
                type="number"
                inputMode="numeric"
                min={0}
                max={90}
                step={1}
                value={trialDays}
                onInput={(event) => {
                  setTrialDays(event.currentTarget.value);
                  setSaved(false);
                }}
              />
            </Field>
          </Card>
          <Card title="Automatic-change threshold">
            <AutoCreateSummary status={status.data.autoCreate} />
            <Field
              id="threshold"
              label={`Change tasks automatically at ${Math.round(threshold * 100)}% confidence or more`}
              hint="Below the threshold, or when the model flags any ambiguity, a proposal goes to Review. The same minimum applies when your own message closes, cancels, or reschedules a task. New tasks also need the calibrated threshold from your Review decisions, whichever is higher."
            >
              <input
                id="threshold"
                type="range"
                min={0.5}
                max={0.99}
                step={0.01}
                value={threshold}
                aria-valuetext={`${Math.round(threshold * 100)} percent`}
                onInput={(event) => {
                  setThreshold(Number(event.currentTarget.value));
                  setSaved(false);
                }}
              />
            </Field>
            {status.data.policy ? null : (
              <p class="hint">This server does not report the current threshold; saving sets it to the value shown.</p>
            )}
          </Card>
          {save.error ? <Notice tone="error">{save.error}</Notice> : null}
          {saved ? <Notice tone="ok">Policy saved.</Notice> : null}
          <div class="sticky-actions">
            <Button variant="primary" type="submit" busy={save.busy}>
              Save policy
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
