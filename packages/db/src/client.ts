import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.ts";

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates shifted by timezone.
pg.types.setTypeParser(1082, (v: string) => v);

export type DB = Kysely<Database>;

export function createDb(connectionString: string, options: { max?: number } = {}): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: options.max ?? 10 }),
    }),
  });
}
