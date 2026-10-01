import { audit, type AuditSink } from "./audit";
import { loadConfig, publicConfig, type Config, type Env } from "./config";
import type { Context } from "./context";
import { GitHubApp, type FetchFn } from "./github";
import { handleLink } from "./handlers/link";
import { homePage, installedPage, manifestCallbackPage } from "./handlers/pages";
import { handleToken } from "./handlers/token";
import { handleUnlink } from "./handlers/unlink";
import { handleWebhook } from "./handlers/webhook";
import { json, problem, readBody } from "./http";
import { Store } from "./store";

const MAX_API_BODY_BYTES = 16 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

type PostHandler = (ctx: Context, request: Request, body: Uint8Array) => Promise<Response>;

const POST_ROUTES: Record<string, { handler: PostHandler; maxBytes: number }> = {
  "/link": { handler: handleLink, maxBytes: MAX_API_BODY_BYTES },
  "/token": { handler: handleToken, maxBytes: MAX_API_BODY_BYTES },
  "/unlink": { handler: handleUnlink, maxBytes: MAX_API_BODY_BYTES },
  "/webhook": { handler: handleWebhook, maxBytes: MAX_WEBHOOK_BODY_BYTES },
};

const GET_ROUTES: Record<string, (config: Config) => Response> = {
  "/": homePage,
  "/config": (config) => json(200, publicConfig(config)),
  "/healthz": () => json(200, { ok: true }),
  "/installed": installedPage,
  "/manifest-callback": () => manifestCallbackPage(),
};

export interface Dependencies {
  fetchFn: FetchFn;
  nowSeconds: () => number;
  log: AuditSink;
}

const defaultDependencies: Dependencies = {
  fetchFn: (input, init) => fetch(input, init),
  nowSeconds: () => Math.floor(Date.now() / 1000),
  log: (line) => console.log(line),
};

export async function handleRequest(
  request: Request,
  env: Env,
  deps: Dependencies = defaultDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const ray = request.headers.get("CF-Ray") ?? "";
  let config: Config;
  try {
    config = loadConfig(env);
  } catch {
    audit(deps.log, "service_error", { outcome: "error", reason: "misconfigured", ray });
    return problem(500, "misconfigured", "The token service is not configured correctly.");
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const page = GET_ROUTES[url.pathname];
    return page ? page(config) : problem(404, "not_found", "No such endpoint.");
  }
  if (request.method !== "POST") {
    return problem(405, "method_not_allowed", "Use GET or POST.", {}, { Allow: "GET, HEAD, POST" });
  }
  const route = POST_ROUTES[url.pathname];
  if (!route) return problem(404, "not_found", "No such endpoint.");

  const body = await readBody(request, route.maxBytes);
  if (!body) return problem(413, "body_too_large", "Request body is too large.");

  const ctx: Context = {
    config,
    store: new Store(env.DB),
    app: new GitHubApp(
      { apiUrl: config.apiUrl, clientId: config.clientId, privateKeyPem: config.privateKeyPem },
      deps.fetchFn,
      deps.nowSeconds,
    ),
    fetchFn: deps.fetchFn,
    nowSeconds: deps.nowSeconds,
    log: deps.log,
    ray,
    clientIp: request.headers.get("CF-Connecting-IP") ?? "unknown",
  };
  try {
    return await route.handler(ctx, request, body);
  } catch {
    audit(deps.log, "service_error", { outcome: "error", reason: `unhandled_${url.pathname.slice(1)}`, ray });
    return problem(500, "internal_error", "The token service hit an unexpected error.");
  }
}

export async function purgeExpired(env: Env, deps: Dependencies = defaultDependencies): Promise<void> {
  await new Store(env.DB).purgeExpired(deps.nowSeconds());
  audit(deps.log, "purge", { outcome: "ok" });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeExpired(env));
  },
} satisfies ExportedHandler<Env>;
