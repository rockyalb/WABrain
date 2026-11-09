import { useEffect, useState } from "preact/hooks";
import { Button, Card, Field, LoadError, Notice, PageHeader, Spinner, formatDate, useAction, useApi, useLoad } from "../components/ui";

const DEFAULT_THRESHOLD = 0.8;

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
        Proposed tasks are created on their own when the model is confident enough. Anything less certain waits in Review.
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
            <Field id="trial-days" label="Trial length in days" hint="During the trial every new task waits in Review. 0 ends the trial now. The start date does not change.">
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
            <Field
              id="threshold"
              label={`Change tasks automatically at ${Math.round(threshold * 100)}% confidence or more`}
              hint="Below the threshold, or when the model flags any ambiguity, a proposal goes to Review. The same minimum applies when your own message closes, cancels, or reschedules a task. A task the chat shows already done is saved straight to Done."
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
