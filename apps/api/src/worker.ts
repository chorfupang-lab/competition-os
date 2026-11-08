/**
 * Background worker: runs maintenance on an interval. Start one or more:
 *   pnpm --filter @cos/api worker
 * Later stages add queued jobs here (AI scoring, certificates, notifications).
 */
import { createDb } from "@cos/db";
import { createAiDeps } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runMaintenance } from "./lib/maintenance.ts";

const config = loadConfig();
const db = createDb(config.appDatabaseUrl, { max: 4 });
const ai = createAiDeps(config);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 15_000);
let stopping = false;

async function loop() {
  while (!stopping) {
    try {
      const report = await runMaintenance(db, new Date(), ai);
      if (report.attemptsSubmitted || report.competitionsSwept || report.ai?.succeeded || report.ai?.failed) console.log(JSON.stringify({ msg: "maintenance", ...report }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "maintenance failed", error: (err as Error).message }));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await db.destroy();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));
void loop();
