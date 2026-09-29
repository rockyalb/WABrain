// Worker healthcheck: the process is alive (this runs inside its container) and the database, which
// holds the job queue, answers. Exits 0 when healthy, 1 otherwise. Never prints the connection string.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) process.exit(1);

const sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
try {
  await sql`select 1`;
  await sql.end({ timeout: 1 });
  process.exit(0);
} catch {
  process.exit(1);
}
