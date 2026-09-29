export type Section = "tasks" | "people" | "chats" | "ask" | "settings" | "overview" | "whatsapp" | "providers" | "usage" | "phones" | "policy" | "import" | "danger";

export const WORKSPACE_SECTIONS: Section[] = ["tasks", "people", "chats", "ask", "settings"];

export const SECTIONS: { id: Section; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "people", label: "People" },
  { id: "chats", label: "Chats" },
  { id: "ask", label: "Ask" },
  { id: "settings", label: "Settings" },
  { id: "overview", label: "Overview" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "providers", label: "AI providers" },
  { id: "usage", label: "Usage & cost" },
  { id: "phones", label: "Phones" },
  { id: "policy", label: "Policy" },
  { id: "import", label: "History import" },
  { id: "danger", label: "Danger zone" },
];

export function sectionFromHash(hash: string): Section {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return SECTIONS.some((section) => section.id === id) ? (id as Section) : "tasks";
}
