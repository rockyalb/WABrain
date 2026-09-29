/** `pnpm --filter @wabrain/db migrate` — applies pending migrations. */
import { createDatabase } from "../client.js";
import { ensureDefaults } from "../repos/settings.js";
import { runMigrations } from "../migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const database = createDatabase(url, { max: 2 });
try {
  await runMigrations(database);
  await ensureDefaults(database.db);
  console.log("Migrations applied");
} finally {
  await database.close();
}
