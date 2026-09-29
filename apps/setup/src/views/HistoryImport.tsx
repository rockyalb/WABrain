import { useEffect, useState } from "preact/hooks";
import { IMPORT_DAYS, describeError, isRateLimited, type ImportRun } from "../api";
import { Badge, Button, Card, LoadError, Notice, PageHeader, Spinner, formatDate, useAction, useApi, useLoad } from "../components/ui";
import { COVERAGE_POLL_MS, coverageTotals, isActive, mergeRun, progressPercent, runBadge, startLabel } from "../history";

function Progress(props: { run: ImportRun }) {
  const percent = progressPercent(props.run);
  if (percent === null) return isActive(props.run) ? <p class="muted small">Counting the stored messages…</p> : null;
  return (
    <span class="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Import progress">
      <span class="meter-fill meter-ok" style={{ width: `${percent}%` }} />
    </span>
  );
}

export function HistoryImport() {
  const api = useApi();
  const coverage = useLoad(() => api.importCoverage(), []);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [confirmStart, setConfirmStart] = useState(false);

  useEffect(() => {
    if (coverage.data) setRun(coverage.data.run);
  }, [coverage.data]);

  const active = isActive(run);

  // While an import runs, refresh the report at the pace the server allows.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void coverage.reload(), COVERAGE_POLL_MS);
    return () => clearInterval(timer);
  }, [active, coverage.reload]);

  const start = useAction(async () => {
    const started = await api.startImport(IMPORT_DAYS);
    setRun((previous) => mergeRun(previous, started));
    setConfirmStart(false);
    await coverage.reload();
  });
  const cancel = useAction(async () => {
    const cancelled = await api.cancelImport();
    setRun((previous) => mergeRun(previous, cancelled));
  });

  const data = coverage.data;
  const items = data?.items ?? [];
  const totals = coverageTotals(items);
  const badge = runBadge(run);
  const percent = progressPercent(run);
  // A failed refresh keeps the last report on screen; only a first load failure replaces it.
  const refreshProblem = data && coverage.error ? coverage.error : null;

  return (
    <>
      <PageHeader
        kicker="History import"
        title={`Import ${IMPORT_DAYS} days of history`}
        actions={
          data ? (
            <Button variant="ghost" busy={coverage.loading} onClick={() => void coverage.reload()}>
              Refresh
            </Button>
          ) : null
        }
      >
        The import reads what OpenWA already stored from WhatsApp's history sync, reaching back {IMPORT_DAYS} days. Older messages are not imported.
        Everything imported is kept and builds on from there.
      </PageHeader>

      <Notice tone="info" title="Imported history is context only">
        It feeds people, contexts, and search. It never proposes tasks: only new live messages, incoming or outgoing, can do that.
      </Notice>

      {coverage.loading && !data ? <Spinner label="Checking coverage (this can take a while the first time)…" /> : null}
      {coverage.error && !data ? <LoadError error={coverage.error} feature="History import" onRetry={coverage.reload} /> : null}

      {data ? (
        <Card title="Import" aside={<Badge tone={badge.tone}>{badge.label}</Badge>}>
          {run ? (
            <>
              <p class="muted">
                Started {formatDate(run.startedAt)}
                {run.finishedAt ? `, ${run.status === "cancelled" ? "stopped" : "finished"} ${formatDate(run.finishedAt)}` : ""}
                {percent !== null ? ` · ${percent}%` : ""}
              </p>
              <Progress run={run} />
              {active ? <p class="hint">This page refreshes the report about once a minute while the import runs. You can leave it.</p> : null}
            </>
          ) : (
            <p class="muted">
              Check the coverage below first: it shows what OpenWA holds for the last {IMPORT_DAYS} days. Re-pairing WhatsApp for a fresh history sync is a
              last resort, and it also affects other apps that share the session.
            </p>
          )}
          {run?.error ? <Notice tone="error" title="The import stopped with an error">{run.error}</Notice> : null}
          {run?.status === "cancelled" || run?.status === "failed" ? (
            <p class="hint">Resuming continues from the last saved position; nothing is imported twice.</p>
          ) : null}
          <div class="row">
            {active ? (
              <Button variant="secondary" busy={cancel.busy} onClick={() => void cancel.run()}>
                Cancel import
              </Button>
            ) : confirmStart ? (
              <>
                <Button variant="primary" busy={start.busy} onClick={() => void start.run()}>
                  Start import (model calls cost money)
                </Button>
                <Button variant="ghost" onClick={() => setConfirmStart(false)}>
                  Not now
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setConfirmStart(true)}>
                {startLabel(run)}
              </Button>
            )}
          </div>
          {confirmStart ? (
            <p class="hint">
              Imported messages are profiled and indexed for search by the configured AI providers. Completed imports start over; resumed ones do not.
            </p>
          ) : null}
          {start.error ? <Notice tone="error">{start.error}</Notice> : null}
          {cancel.error ? <Notice tone="error">{cancel.error}</Notice> : null}
        </Card>
      ) : null}

      {data ? (
        <Card title="Coverage per chat" aside={<span class="muted small">{items.length === 1 ? "1 chat" : `${items.length} chats`}</span>}>
          <p class="muted">
            {data.source === "openwa"
              ? `What OpenWA holds for the last ${IMPORT_DAYS} days. Nothing has been imported yet.`
              : "What WABrain has stored: imported history plus messages received live."}
          </p>
          {refreshProblem ? (
            <Notice tone={isRateLimited(refreshProblem) ? "info" : "warn"}>
              {isRateLimited(refreshProblem) ? "The report can be refreshed about once a minute. " : "Could not refresh the report. "}
              {describeError(refreshProblem)} Showing the last report.
            </Notice>
          ) : null}
          {items.length === 0 ? (
            <p class="empty">No stored history yet.</p>
          ) : (
            <>
              <dl class="facts">
                <div>
                  <dt>Messages</dt>
                  <dd>{totals.messages.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Earliest</dt>
                  <dd>{formatDate(totals.earliestAt)}</dd>
                </div>
                {data.source === "local" ? (
                  <div>
                    <dt>Media processed / failed</dt>
                    <dd>
                      {totals.mediaOk.toLocaleString()} / <span class={totals.mediaFailed ? "text-error" : ""}>{totals.mediaFailed.toLocaleString()}</span>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Chats with gaps</dt>
                  <dd>{totals.chatsWithGaps}</dd>
                </div>
              </dl>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Chat</th>
                      <th scope="col">Earliest</th>
                      <th scope="col" class="num">
                        Messages
                      </th>
                      {data.source === "local" ? (
                        <th scope="col" class="num">
                          Media ok / failed
                        </th>
                      ) : null}
                      <th scope="col">Gaps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr key={row.chatId}>
                        <th scope="row">{row.chatName ?? row.chatId}</th>
                        <td>{formatDate(row.earliestAt)}</td>
                        <td class="num">{row.messageCount.toLocaleString()}</td>
                        {data.source === "local" ? (
                          <td class="num">
                            {row.mediaOk} / <span class={row.mediaFailed ? "text-error" : ""}>{row.mediaFailed}</span>
                          </td>
                        ) : null}
                        <td>{row.gaps.length ? row.gaps.join(", ") : <span class="muted">none</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      ) : null}
    </>
  );
}
