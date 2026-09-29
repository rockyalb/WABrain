import { useState } from "preact/hooks";
import { Button, Card, Field, Notice, PageHeader, useAction, useApi } from "../components/ui";

export const WIPE_PHRASE = "DELETE EVERYTHING";

export function DangerZone() {
  const api = useApi();
  const [phrase, setPhrase] = useState("");
  const [done, setDone] = useState(false);
  const wipe = useAction(async () => {
    await api.wipe(phrase);
    setPhrase("");
    setDone(true);
  });
  const matches = phrase === WIPE_PHRASE;

  return (
    <>
      <PageHeader kicker="Danger zone" title="Delete everything">
        Removes every stored message, derived text, task, review item, person, and context from this server, and every chat that is On or
        mentions-only. Your WhatsApp account and OpenWA's own data are not touched.
      </PageHeader>
      <Card title="What stays">
        <ul class="steps">
          <li>
            <b>The Off list.</b> Every chat you switched Off stays Off, reduced to its WhatsApp id and mode; its name, person, and context are
            cleared. Nothing from it is stored afterwards, by new messages or a history import.
          </li>
          <li>The owner account, paired phones, settings, provider settings, and the audit log.</li>
        </ul>
        <p class="hint">
          To drop a chat from the Off list, switch it On in the app before wiping; the wipe then deletes it like any other chat. After the wipe, phones
          resync and list only the kept Off chats.
        </p>
      </Card>
      {done ? (
        <Notice tone="ok" title="All data was deleted">
          Off chats stayed Off. Messages from every other chat will be stored again as they arrive. To stop that, remove the webhook in OpenWA or shut
          the server down. Backups made earlier still contain the old data; delete them too (see docs/OPERATIONS.md).
        </Notice>
      ) : null}
      <Card title="Full wipe" class="card-danger">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (matches) void wipe.run();
          }}
        >
          <Field id="wipe-confirm" label={`Type ${WIPE_PHRASE} to confirm`} hint="This cannot be undone.">
            <input
              id="wipe-confirm"
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              value={phrase}
              onInput={(event) => setPhrase(event.currentTarget.value)}
              aria-invalid={phrase.length > 0 && !matches}
            />
          </Field>
          {wipe.error ? <Notice tone="error">{wipe.error}</Notice> : null}
          <Button variant="danger" type="submit" busy={wipe.busy} disabled={!matches}>
            Delete all data
          </Button>
        </form>
      </Card>
    </>
  );
}
