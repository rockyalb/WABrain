import type { ReviewItemType } from "@wabrain/contracts";

/**
 * Change notifications, emitted after a mutation commits. The UnifiedPush
 * sender (built separately) implements `ChangeNotifier`; the shapes mirror the
 * push payloads in docs/API.md.
 *
 * Exactly one event is emitted per committed operation: `review` when a new
 * Review item was created, or a pending one was replaced by a changed proposal
 * (it implies `sync`), otherwise `sync`.
 */
export type ChangeEvent =
  | { type: "sync" }
  | {
      type: "review";
      reviewItemId: string;
      reviewType: ReviewItemType;
      /** Task title (never raw message text). */
      title: string;
    };

export interface ChangeNotifier {
  notify(event: ChangeEvent): void | Promise<void>;
}

export const noopNotifier: ChangeNotifier = { notify() {} };

/** Calls the notifier without letting a push failure fail the mutation. */
export async function safeNotify(
  notifier: ChangeNotifier,
  event: ChangeEvent,
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  try {
    await notifier.notify(event);
  } catch (error) {
    onError(error);
  }
}
