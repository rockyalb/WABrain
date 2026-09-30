/** Canonical workspace location for one Review proposal. */
export function reviewTargetHref(reviewItemId: string): string {
  return `#/tasks/review?item=${encodeURIComponent(reviewItemId)}`;
}

/** Reads a Review proposal id from a workspace hash without accepting other task routes. */
export function reviewTargetFromHash(hash: string): string | null {
  const marker = hash.indexOf("#");
  const fragment = (marker >= 0 ? hash.slice(marker + 1) : hash).replace(/^\//, "");
  const [path, query = ""] = fragment.split("?", 2);
  if (path !== "tasks/review") return null;
  const item = new URLSearchParams(query).get("item")?.trim();
  return item || null;
}
