CREATE TABLE "contact_names" (
	"jid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"synced_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
