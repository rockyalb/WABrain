import { useMemo, useState } from "preact/hooks";
import type { UsageReport } from "../api";
import { Card, LoadError, Notice, PageHeader, Spinner, useApi, useLoad } from "../components/ui";

const DAYS = 30;
/** Categorical slots in fixed order (validated on the page surface); the rest fold into "Other". */
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];
const OTHER = "#8a948c";

const usd = (value: number) =>
  value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : value > 0 ? `$${value.toFixed(3)}` : "$0";
const count = (value: number) => value.toLocaleString();

/** Every UTC day from `since`, "YYYY-MM-DD", so empty days still show. */
function dayRange(since: string, days: number): string[] {
  const start = Date.parse(since);
  return Array.from({ length: days }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

interface Series {
  name: string;
  color: string;
}

function CostChart({ days, byDay, series }: { days: string[]; byDay: Map<string, Map<string, number>>; series: Series[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const totals = days.map((day) => [...(byDay.get(day)?.values() ?? [])].reduce((sum, value) => sum + value, 0));
  const max = Math.max(...totals, 0.01);
  const width = 720;
  const height = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slot = plotW / days.length;
  const barW = Math.max(4, Math.min(18, slot - 4));
  const ticks = [0, max / 2, max];
  const hovered = hover ? byDay.get(hover) : undefined;
  return (
    <div class="usage-chart">
      <div class="usage-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Cost per day by model">
        {ticks.map((tick) => {
          const y = pad.top + plotH - (tick / max) * plotH;
          return (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} class="usage-grid" />
              <text x={pad.left - 6} y={y + 4} class="usage-axis" text-anchor="end">
                {usd(tick)}
              </text>
            </g>
          );
        })}
        {days.map((day, index) => {
          const x = pad.left + index * slot + (slot - barW) / 2;
          let y = pad.top + plotH;
          const values = byDay.get(day);
          const segments = series
            .map((s) => ({ s, value: values?.get(s.name) ?? 0 }))
            .filter((segment) => segment.value > 0)
            .map(({ s, value }) => {
              const h = Math.max(1, (value / max) * plotH);
              y -= h;
              // A 2px surface gap between stacked segments.
              return <rect key={s.name} x={x} y={y + 1} width={barW} height={Math.max(0, h - 2)} rx={2} fill={s.color} />;
            });
          return (
            <g
              key={day}
              role="button"
              tabIndex={0}
              aria-label={`${shortDay(day)}: ${usd(totals[index] ?? 0)}`}
              class="usage-day"
              onMouseEnter={() => setHover(day)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(day)}
              onBlur={() => setHover(null)}
            >
              <rect x={pad.left + index * slot} y={pad.top} width={slot} height={plotH} fill="transparent" />
              {segments}
              {index % 5 === 0 || index === days.length - 1 ? (
                <text x={x + barW / 2} y={height - 8} class="usage-axis" text-anchor="middle">
                  {shortDay(day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      </div>
      <div class="usage-tooltip" aria-live="polite">
        {hover ? (
          <>
            <strong>
              {shortDay(hover)}: {usd(totals[days.indexOf(hover)] ?? 0)}
            </strong>
            {series
              .filter((s) => (hovered?.get(s.name) ?? 0) > 0)
              .map((s) => (
                <span key={s.name}>
                  <i style={{ background: s.color }} /> {s.name} {usd(hovered!.get(s.name)!)}
                </span>
              ))}
          </>
        ) : (
          <span class="muted">Point at a day to see its breakdown.</span>
        )}
      </div>
      <ul class="usage-legend">
        {series.map((s) => (
          <li key={s.name}>
            <i style={{ background: s.color }} /> {s.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CostSection({ report }: { report: UsageReport }) {
  const { costs } = report;
  const days = useMemo(() => dayRange(report.since, report.days), [report]);
  if (costs.status === "not_configured") {
    return (
      <Notice tone="info" title="Costs need an OpenAI Admin key">
        Set <code>OPENAI_ADMIN_KEY</code> on the API service to show what OpenAI billed per day. Optionally set <code>OPENAI_COSTS_PROJECT_ID</code> to a
        project only WABrain uses; otherwise the costs cover your whole OpenAI organization.
      </Notice>
    );
  }
  if (costs.status === "error") return <Notice tone="error" title="Could not load costs">{costs.message}</Notice>;
  const byDay = new Map(costs.days.map((d) => [d.day, new Map(d.items.map((item) => [item.lineItem, item.usd]))]));
  const totals = new Map<string, number>();
  for (const d of costs.days) for (const item of d.items) totals.set(item.lineItem, (totals.get(item.lineItem) ?? 0) + item.usd);
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, SERIES.length).map(([name], index) => ({ name, color: SERIES[index]! }));
  const rest = new Set(ranked.slice(SERIES.length).map(([name]) => name));
  const series: Series[] = rest.size ? [...top, { name: "Other", color: OTHER }] : top;
  const folded = new Map(
    [...byDay].map(([day, items]) => {
      const out = new Map<string, number>();
      for (const [name, value] of items) out.set(rest.has(name) ? "Other" : name, (out.get(rest.has(name) ? "Other" : name) ?? 0) + value);
      return [day, out];
    }),
  );
  const total = ranked.reduce((sum, [, value]) => sum + value, 0);
  return (
    <>
      <p class="usage-total">
        <strong>{usd(total)}</strong> <span class="muted">billed by OpenAI in the last {report.days} days</span>
      </p>
      <p class="muted">
        {costs.projectId ? `OpenAI project ${costs.projectId}.` : "Your whole OpenAI organization, including other apps that use it."} Today's costs can
        take a few hours to appear.
      </p>
      <CostChart days={days} byDay={folded} series={series} />
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Line item</th>
              <th scope="col" class="num">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {ranked.map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td class="num">{usd(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ModelTable({ report }: { report: UsageReport }) {
  const rows = useMemo(() => {
    const byModel = new Map<string, { model: string; roles: Set<string>; calls: number; input: number; output: number; audio: number }>();
    for (const row of report.usage) {
      const model = row.model ?? "(unknown)";
      const entry = byModel.get(model) ?? { model, roles: new Set<string>(), calls: 0, input: 0, output: 0, audio: 0 };
      entry.roles.add(row.role);
      entry.calls += row.calls;
      entry.input += row.inputTokens;
      entry.output += row.outputTokens;
      entry.audio += row.audioSeconds;
      byModel.set(model, entry);
    }
    return [...byModel.values()].sort((a, b) => b.calls - a.calls);
  }, [report]);
  if (!rows.length) return <p class="muted">No model calls in the last {report.days} days.</p>;
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Used for</th>
            <th scope="col" class="num">
              Calls
            </th>
            <th scope="col" class="num">
              Input tokens
            </th>
            <th scope="col" class="num">
              Output tokens
            </th>
            <th scope="col" class="num">
              Audio
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.model}>
              <th scope="row">{row.model}</th>
              <td>{[...row.roles].join(", ")}</td>
              <td class="num">{count(row.calls)}</td>
              <td class="num">{count(row.input)}</td>
              <td class="num">{count(row.output)}</td>
              <td class="num">{row.audio ? `${(row.audio / 60).toFixed(1)} min` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayTable({ report }: { report: UsageReport }) {
  const days = dayRange(report.since, report.days).reverse();
  const cost = new Map(report.costs.status === "ok" ? report.costs.days.map((d) => [d.day, d.items.reduce((sum, item) => sum + item.usd, 0)]) : []);
  const usage = new Map<string, { calls: number; tokens: number }>();
  for (const row of report.usage) {
    const entry = usage.get(row.day) ?? { calls: 0, tokens: 0 };
    entry.calls += row.calls;
    entry.tokens += row.inputTokens + row.outputTokens;
    usage.set(row.day, entry);
  }
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            <th scope="col" class="num">
              Calls
            </th>
            <th scope="col" class="num">
              Tokens
            </th>
            {report.costs.status === "ok" ? (
              <th scope="col" class="num">
                Cost
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day}>
              <th scope="row">{shortDay(day)}</th>
              <td class="num">{count(usage.get(day)?.calls ?? 0)}</td>
              <td class="num">{count(usage.get(day)?.tokens ?? 0)}</td>
              {report.costs.status === "ok" ? <td class="num">{usd(cost.get(day) ?? 0)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Usage() {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.usage(DAYS), [api]);
  return (
    <>
      <PageHeader kicker="Usage" title="Models and cost">
        <p>What the AI models were used for over the last {DAYS} days, and what OpenAI billed per day.</p>
      </PageHeader>
      {error ? <LoadError error={error} feature="usage" onRetry={reload} /> : null}
      {!data && loading ? <Spinner label="Loading usage" /> : null}
      {data ? (
        <>
          <Card title="Cost per day">
            <CostSection report={data} />
          </Card>
          <Card title="Usage by model">
            <ModelTable report={data} />
          </Card>
          <Card title="Per day">
            <DayTable report={data} />
          </Card>
        </>
      ) : null}
    </>
  );
}
