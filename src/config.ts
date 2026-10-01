export interface Env {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_BOT_USER_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_API_URL?: string;
  GITHUB_WEB_URL?: string;
  TOKEN_REQUESTS_PER_MINUTE?: string;
  LINK_REQUESTS_PER_HOUR?: string;
  MAX_INSTANCES_PER_USER?: string;
}

export interface Config {
  appId: number;
  clientId: string;
  slug: string;
  botUserId: number;
  privateKeyPem: string;
  webhookSecret: string;
  apiUrl: string;
  webUrl: string;
  tokenRequestsPerMinute: number;
  linkRequestsPerHour: number;
  maxInstancesPerUser: number;
}

function positiveInt(name: string, raw: string | undefined, fallback?: number): number {
  if ((raw === undefined || raw === "") && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function required(name: string, raw: string | undefined): string {
  if (!raw) throw new Error(`${name} is not configured`);
  return raw;
}

export function loadConfig(env: Env): Config {
  return {
    appId: positiveInt("GITHUB_APP_ID", env.GITHUB_APP_ID),
    clientId: required("GITHUB_APP_CLIENT_ID", env.GITHUB_APP_CLIENT_ID),
    slug: required("GITHUB_APP_SLUG", env.GITHUB_APP_SLUG),
    botUserId: positiveInt("GITHUB_BOT_USER_ID", env.GITHUB_BOT_USER_ID),
    privateKeyPem: required("GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY),
    webhookSecret: required("GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET),
    apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    webUrl: (env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, ""),
    tokenRequestsPerMinute: positiveInt("TOKEN_REQUESTS_PER_MINUTE", env.TOKEN_REQUESTS_PER_MINUTE, 60),
    linkRequestsPerHour: positiveInt("LINK_REQUESTS_PER_HOUR", env.LINK_REQUESTS_PER_HOUR, 10),
    maxInstancesPerUser: positiveInt("MAX_INSTANCES_PER_USER", env.MAX_INSTANCES_PER_USER, 10),
  };
}

export function publicConfig(config: Config) {
  const botLogin = `${config.slug}[bot]`;
  return {
    app_id: config.appId,
    client_id: config.clientId,
    slug: config.slug,
    install_url: `${config.webUrl}/apps/${config.slug}/installations/new`,
    bot: {
      login: botLogin,
      id: config.botUserId,
      email: `${config.botUserId}+${botLogin}@users.noreply.github.com`,
    },
    scopes: ["write", "git", "read"],
  };
}
