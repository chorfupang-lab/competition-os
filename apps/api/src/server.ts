import { createDb } from "@cos/db";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const db = createDb(config.appDatabaseUrl);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
