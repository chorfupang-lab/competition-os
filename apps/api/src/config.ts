export interface Config {
  appDatabaseUrl: string;
  port: number;
  nodeEnv: string;
  allowedOrigins: string[];
  sessionTtlHours: number;
  cookieSecure: boolean;
  rateLimit: { enabled: boolean; globalPerMinute: number; authPerMinute: number };
  logger: boolean;
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
  };
}
