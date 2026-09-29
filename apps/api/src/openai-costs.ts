/**
 * Daily costs from OpenAI's organization Costs API (GET /v1/organization/costs), for the setup
 * page's usage breakdown. Needs an OpenAI Admin key; the amounts are what OpenAI bills, for the whole
 * organization unless a project id narrows them. The key is sent only to api.openai.com.
 */
const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const MAX_PAGES = 20;

export interface DailyCost {
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  items: Array<{ lineItem: string; usd: number }>;
}

export type CostsResult =
  | { status: "ok"; projectId: string | null; days: DailyCost[] }
  | { status: "not_configured" }
  | { status: "error"; message: string };

interface CostsPage {
  data?: Array<{ start_time?: number; results?: Array<{ amount?: { value?: number | string; currency?: string }; line_item?: string | null }> }>;
  has_more?: boolean;
  next_page?: string | null;
}

export async function fetchOpenAiCosts(options: {
  access: { adminKey: string; projectId: string | null } | null;
  since: Date;
  days: number;
  fetch?: typeof fetch;
}): Promise<CostsResult> {
  if (!options.access) return { status: "not_configured" };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const byDay = new Map<string, Map<string, number>>();
  let page: string | null = null;
  for (let count = 0; count < MAX_PAGES; count += 1) {
    const query = new URLSearchParams({
      start_time: String(Math.floor(options.since.getTime() / 1000)),
      bucket_width: "1d",
      limit: String(Math.min(Math.max(options.days, 1), 180)),
    });
    query.append("group_by", "line_item");
    if (options.access.projectId) query.append("project_ids", options.access.projectId);
    if (page) query.set("page", page);
    let response: Response;
    try {
      response = await fetchImpl(`${COSTS_URL}?${query.toString()}`, {
        headers: { authorization: `Bearer ${options.access.adminKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      return { status: "error", message: "OpenAI could not be reached." };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: "error", message: "OpenAI refused the admin key. It needs read access to usage (an Admin key, not a project key)." };
    }
    if (!response.ok) return { status: "error", message: `OpenAI answered ${response.status}.` };
    const body = (await response.json().catch(() => null)) as CostsPage | null;
    if (!body || !Array.isArray(body.data)) return { status: "error", message: "OpenAI sent an unexpected cost report." };
    for (const bucket of body.data) {
      if (typeof bucket.start_time !== "number") continue;
      const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      const items = byDay.get(day) ?? new Map<string, number>();
      for (const result of bucket.results ?? []) {
        const usd = Number(result.amount?.value ?? 0);
        if (!Number.isFinite(usd) || usd === 0) continue;
        const lineItem = result.line_item?.trim() || "other";
        items.set(lineItem, (items.get(lineItem) ?? 0) + usd);
      }
      byDay.set(day, items);
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  const days = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => ({
      day,
      items: [...items].map(([lineItem, usd]) => ({ lineItem, usd: Math.round(usd * 10_000) / 10_000 })).sort((a, b) => b.usd - a.usd),
    }));
  return { status: "ok", projectId: options.access.projectId, days };
}
