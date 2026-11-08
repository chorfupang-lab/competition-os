import { migrate } from "../migrate.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (owner connection) is required");
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
