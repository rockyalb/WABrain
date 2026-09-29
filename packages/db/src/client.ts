import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type ReservedSql, type Sql, type TransactionSql } from "postgres";

/** Drizzle handle bound either to the pool or to one transaction. */
export type Db = PostgresJsDatabase<Record<string, never>>;

export interface TxContext {
  db: Db;
  /** The raw postgres.js transaction, e.g. for transactional pg-boss sends. */
  sql: TransactionSql;
}

export interface Database {
  sql: Sql;
  db: Db;
  /** Runs `fn` in one transaction. Do not nest. */
  transaction<T>(fn: (tx: TxContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  max?: number;
  /** Silence NOTICE messages (e.g. "extension already exists"). Default true. */
  quiet?: boolean;
}

/**
 * postgres.js transaction/reserved handles lack `options`, which drizzle reads
 * when wrapping a client; borrow the pool's.
 */
export function drizzleFor(child: TransactionSql | ReservedSql, parent: Sql): Db {
  const client = child as unknown as { options?: unknown; parameters?: unknown };
  client.options ??= parent.options;
  client.parameters ??= parent.parameters;
  return drizzle(child as unknown as Sql) as unknown as Db;
}

export function createDatabase(url: string, options: DatabaseOptions = {}): Database {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: options.quiet === false ? undefined : () => {},
    connection: { application_name: "wabrain" },
  });
  const db = drizzle(sql) as unknown as Db;
  return {
    sql,
    db,
    transaction: (fn) =>
      sql.begin((tx) => fn({ db: drizzleFor(tx, sql), sql: tx })) as Promise<
        Awaited<ReturnType<typeof fn>>
      >,
    close: () => sql.end({ timeout: 5 }),
  };
}
