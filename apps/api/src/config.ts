export interface Config {
  appDatabaseUrl: string;
  port: number;
  nodeEnv: string;
  allowedOrigins: string[];
  sessionTtlHours: number;
  cookieSecure: boolean;
  rateLimit: { enabled: boolean; globalPerMinute: number; authPerMinute: number };
  logger: boolean;
  ai: {
    blobDir: string;
    pronunciation: { provider: "mock" | "http"; url: string | null; token: string | null };
    feedback: { provider: "template" | "anthropic"; model: string };
    /** Estimated cost per minute of analysed audio, in millionths of a dollar. */
    pronunciationMicrosPerMinute: number;
  };
  payments: {
    /** Public URL of the web app (checkout return pages, receipt links). */
    appUrl: string;
    /** Never enabled in production. */
    testProvider: { webhookSecret: string } | null;
    airwallex: { baseUrl: string; clientId: string; apiKey: string; webhookSecret: string; env: "demo" | "prod" } | null;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appDatabaseUrl = env.APP_DATABASE_URL;
  if (!appDatabaseUrl) throw new Error("APP_DATABASE_URL is required (restricted cos_app connection)");
  const nodeEnv = env.NODE_ENV ?? "development";
  return {
    appDatabaseUrl,
    port: Number(env.PORT ?? 3000),
    nodeEnv,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 168),
    cookieSecure: (env.COOKIE_SECURE ?? (nodeEnv === "production" ? "true" : "false")) === "true",
    rateLimit: { enabled: true, globalPerMinute: 300, authPerMinute: 10 },
    logger: nodeEnv !== "test",
    ai: {
      blobDir: env.BLOB_DIR ?? "./.data/blobs",
      pronunciation: env.PRONUNCIATION_URL
        ? { provider: "http", url: env.PRONUNCIATION_URL, token: env.PRONUNCIATION_TOKEN ?? null }
        : { provider: "mock", url: null, token: null },
      // The Anthropic SDK reads its credentials from the environment (ANTHROPIC_API_KEY or a profile).
      feedback: env.AI_FEEDBACK_PROVIDER === "anthropic"
        ? { provider: "anthropic", model: env.AI_FEEDBACK_MODEL ?? "claude-opus-5-5" }
        : { provider: "template", model: "" },
      pronunciationMicrosPerMinute: Number(env.PRONUNCIATION_MICROS_PER_MINUTE ?? 6000),
    },
    payments: {
      appUrl: env.APP_URL ?? "http://localhost:5173",
      testProvider:
        nodeEnv !== "production" && env.PAYMENTS_TEST_PROVIDER !== "off"
          ? { webhookSecret: env.PAYMENTS_TEST_WEBHOOK_SECRET ?? "test-webhook-secret" }
          : null,
      // Credentials come from the environment (secrets manager), never from the database or the repo.
      airwallex:
        env.AIRWALLEX_CLIENT_ID && env.AIRWALLEX_API_KEY && env.AIRWALLEX_WEBHOOK_SECRET
          ? {
              baseUrl: env.AIRWALLEX_BASE_URL ?? "https://api-demo.airwallex.com",
              clientId: env.AIRWALLEX_CLIENT_ID,
              apiKey: env.AIRWALLEX_API_KEY,
              webhookSecret: env.AIRWALLEX_WEBHOOK_SECRET,
              env: env.AIRWALLEX_ENV === "prod" ? "prod" : "demo",
            }
          : null,
    },
  };
}
