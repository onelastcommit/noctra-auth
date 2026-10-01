import { audit } from "../audit";
import { publicConfig } from "../config";
import type { Context } from "../context";
import { randomId, sha256, toHex, utf8 } from "../encoding";
import { GitHubError, GitHubUser, type InstallationSummary } from "../github";
import { json, parseJsonObject, problem } from "../http";
import { checkRateLimit } from "../ratelimit";
import { decodePublicKey, readSignedHeaders } from "../signing";
import { verifySignature } from "../verify";

const GITHUB_TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

export async function handleLink(ctx: Context, request: Request, body: Uint8Array): Promise<Response> {
  const reject = (status: number, reason: string, message: string, extra: Record<string, unknown> = {}, githubUserId?: number) => {
    audit(ctx.log, "link_rejected", { outcome: "denied", reason, github_user_id: githubUserId, ray: ctx.ray });
    return problem(status, reason, message, extra);
  };

  const ipBucket = `link:${toHex(await sha256(utf8(ctx.clientIp))).slice(0, 32)}`;
  const limit = await checkRateLimit(ctx.store, ipBucket, ctx.config.linkRequestsPerHour, 3600, ctx.nowSeconds());
  if (!limit.allowed) {
    audit(ctx.log, "link_rejected", { outcome: "denied", reason: "rate_limited", ray: ctx.ray });
    return problem(429, "rate_limited", "Too many link attempts. Try again later.", {}, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const parsed = parseJsonObject(body);
  const githubToken = parsed?.github_token;
  const publicKey = parsed?.public_key;
  if (
    typeof githubToken !== "string" ||
    !GITHUB_TOKEN_PATTERN.test(githubToken) ||
    typeof publicKey !== "string" ||
    !decodePublicKey(publicKey)
  ) {
    return reject(400, "invalid_request", "Expected a JSON body with github_token and a base64 Ed25519 public_key.");
  }

  const signed = readSignedHeaders(request.headers, false);
  if (typeof signed === "string") {
    return reject(401, signed, "The request signature could not be verified.");
  }
  const keyFingerprint = toHex(await sha256(utf8(publicKey))).slice(0, 32);
  const failure = await verifySignature(ctx, request, "/link", body, publicKey, signed, `link:${keyFingerprint}`, "link_rejected");
  if (failure) return failure;

  const user = new GitHubUser(ctx.config.apiUrl, githubToken, ctx.fetchFn);
  let identity: { id: number; login: string };
  let installations: InstallationSummary[];
  try {
    identity = await user.identity();
    installations = await user.installationsOfApp(ctx.config.appId);
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : 0;
    if (status === 401 || status === 403) {
      return reject(401, "invalid_github_token", "GitHub did not accept the user access token. Run `noctra github login` again.");
    }
    audit(ctx.log, "link_rejected", { outcome: "error", reason: `github_${status || "unreachable"}`, ray: ctx.ray });
    return problem(502, "github_unavailable", "GitHub could not be reached. Try again shortly.");
  }

  if (installations.length === 0) {
    return reject(
      409,
      "no_installations",
      `No installations of ${ctx.config.slug} are visible to ${identity.login}. Install the app, then log in again.`,
      { install_url: publicConfig(ctx.config).install_url },
      identity.id,
    );
  }
  if (await ctx.store.publicKeyInUse(publicKey)) {
    return reject(409, "public_key_in_use", "This public key is already linked. Generate a new keypair.", {}, identity.id);
  }
  if ((await ctx.store.countInstancesForUser(identity.id)) >= ctx.config.maxInstancesPerUser) {
    return reject(
      409,
      "too_many_instances",
      `${identity.login} already has ${ctx.config.maxInstancesPerUser} linked instances. Run \`noctra github logout\` on one you no longer use.`,
      {},
      identity.id,
    );
  }

  const instanceId = randomId("ni_");
  const installationIds = installations.map((i) => i.id);
  await ctx.store.createInstance(
    { instanceId, githubUserId: identity.id, publicKey, createdAt: ctx.nowSeconds() },
    installationIds,
  );
  audit(ctx.log, "link", {
    outcome: "ok",
    instance_id: instanceId,
    github_user_id: identity.id,
    installation_ids: installationIds,
    ray: ctx.ray,
  });
  return json(201, {
    instance_id: instanceId,
    github_user: { id: identity.id, login: identity.login },
    installations,
    app: publicConfig(ctx.config),
  });
}
