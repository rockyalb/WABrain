/* Browser push uses the same durable notification IDs and review API as Android. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function notifyWindows() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const window of windows) window.postMessage({ type: "workspace:refresh" });
}

async function acknowledge(id) {
  if (!id) return;
  await fetch("/web/notifications/ack", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ ids: [id] }),
  });
}

function reviewTarget(reviewItemId) {
  return reviewItemId ? `/#/tasks/review?item=${encodeURIComponent(reviewItemId)}` : "/#/tasks/review";
}

const HANDLED_TITLES = { done: "Saved as done", cancelled: "Saved as cancelled" };

async function showPayload(payload) {
  if (!payload || !["review", "reminder", "summary", "handled"].includes(payload.type)) return;
  const review = payload.type === "review";
  const confirmation = ["possibly_done", "possibly_cancelled"].includes(payload.reviewType);
  // A create that a later message shows already handled: save it closed, or discard it.
  const handled = review && payload.reviewType === "create" ? payload.handled : null;
  const target = review
    ? reviewTarget(payload.reviewItemId)
    : payload.type === "reminder" || payload.type === "handled" ? `/#/tasks/${encodeURIComponent(payload.taskId)}` : "/#/tasks";
  const title = handled
    ? "Looks already handled"
    : review ? "Review needed"
      : payload.type === "reminder" ? "Task reminder"
        : payload.type === "handled" ? HANDLED_TITLES[payload.status] || "Saved"
          : "Daily summary";
  const body = handled
    ? "A proposed task looks done already."
    : review ? "A task decision is waiting."
      : payload.type === "reminder" ? "A task is due soon."
        : payload.type === "handled" ? "A task from your chats was already handled."
          : "Open your task summary.";
  await self.registration.showNotification(title, {
    body,
    icon: "/app-icon.png",
    badge: "/app-icon.png",
    // One notification per Review item: an update replaces the earlier one instead of stacking.
    tag: review ? `review:${payload.reviewItemId}` : payload.notificationId || `${payload.type}:${payload.taskId || "summary"}`,
    renotify: review,
    data: { target, reviewItemId: payload.reviewItemId || null, notificationId: payload.notificationId || null, handled: handled || null },
    actions: !review ? [] : handled ? [
      { action: "accept", title: handled === "cancelled" ? "Save as cancelled" : "Save as done" },
      { action: "reject", title: "Discard" },
    ] : [
      { action: "accept", title: confirmation ? "Done" : "Accept" },
      { action: "reject", title: confirmation ? "Not yet" : "Reject" },
    ],
  });
  await acknowledge(payload.notificationId).catch(() => {});
  await notifyWindows();
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    await showPayload(payload);
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "workspace:show-notification") {
    event.waitUntil(showPayload(event.data.payload));
  }
});

async function openWorkspace(target) {
  const url = new URL(target || "/#/tasks/review", self.location.origin).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const window = windows.find((candidate) => candidate.url.startsWith(self.location.origin));
  if (window) {
    if ("navigate" in window) await window.navigate(url);
    return window.focus();
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    if ((event.action === "accept" || event.action === "reject") && data.reviewItemId) {
      try {
        const response = await fetch(`/web/review/${encodeURIComponent(data.reviewItemId)}/${event.action}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(event.action === "accept" && data.handled ? { closeAs: data.handled } : {}),
        });
        if (!response.ok) throw new Error(`Decision failed: ${response.status}`);
        event.notification.close();
        await notifyWindows();
        return;
      } catch {
        // A missing connection or expired owner session needs the full Review screen.
      }
    }
    event.notification.close();
    await openWorkspace(data.reviewItemId ? reviewTarget(data.reviewItemId) : data.target);
  })());
});
