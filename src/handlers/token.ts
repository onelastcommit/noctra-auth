import { audit } from "../audit";
import { publicConfig } from "../config";
import type { Context } from "../context";
import { GitHubError, type MintedToken } from "../github";
import { json, parseJsonObject, problem } from "../http";
import { isScope, parseRepository, REPO_ROLES_ALLOWED_TO_MINT, SCOPES, type RepoRef } from "../permissions";
import { checkRateLimit } from "../ratelimit";
import { verifyInstanceRequest } from "../verify";

export async function handleToken(ctx: Context, request: Request, body: Uint8Array): Promise<Response> {
  const verified = await verifyInstanceRequest(ctx, request, "/token", body, "token_rejected");
  if (verified instanceof Response) return verified;
  const { instance } = verified;
  const base = { instance_id: instance.instanceId, github_user_id: instance.githubUserId, ray: ctx.ray };

  const limit = await checkRateLimit(
    ctx.store,
    `token:${instance.instanceId}`,
    ctx.config.tokenRequestsPerMinute,
    60,
    ctx.nowSeconds(),
  );
  if (!limit.allowed) {
    audit(ctx.log, "token_rejected", { ...base, outcome: "denied", reason: "rate_limited" });
    return problem(429, "rate_limited", "Too many token requests from this instance.", {}, {
      "Retry-After": String(limit.retryAfterSeconds),
    });
  }

  const parsed = parseJsonObject(body);
  const repo = parseRepository(parsed?.repository);
  const scope = parsed?.scope;
  if (!repo || !isScope(scope)) {
    audit(ctx.log, "token_rejected", { ...base, outcome: "denied", reason: "invalid_request" });
    return problem(
      400,
      "invalid_request",
      'Expected a JSON body with repository ("owner/name") and scope ("write", "git" or "read").',
    );
  }
  const repository = `${repo.owner}/${repo.name}`;
  const deny = (status: number, reason: string, message: string, extra: Record<string, unknown> = {}) => {
    audit(ctx.log, "token_rejected", { ...base, outcome: "denied", reason, repository, scope });
    return problem(status, reason, message, extra);
  };
  const upstreamFailure = (err: unknown, operation: string) => {
    const status = err instanceof GitHubError ? err.status : 0;
    audit(ctx.log, "token_rejected", {
      ...base,
      outcome: "error",
      reason: `${operation}_${status || "unreachable"}`,
      repository,
      scope,
    });
    return problem(502, "github_unavailable", "GitHub could not be reached. Try again shortly.");
  };

  let installationId: number | null;
  try {
    installationId = await ctx.app.repoInstallationId(repo);
  } catch (err) {
    return upstreamFailure(err, "installation_lookup");
  }
  if (installationId === null) {
    return deny(404, "not_installed", `${ctx.config.slug} is not installed on ${repository}.`, {
      install_url: publicConfig(ctx.config).install_url,
    });
  }
  if (!(await ctx.store.isInstallationLinked(instance.instanceId, installationId))) {
    return deny(
      403,
      "installation_not_linked",
      `The installation covering ${repository} is not linked to this instance. Run \`noctra github login\` again.`,
    );
  }

  let minted: MintedToken;
  try {
    minted = await ctx.app.mintInstallationToken(installationId, repo, SCOPES[scope]);
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 403 || err.status === 404 || err.status === 422)) {
      return deny(
        403,
        "installation_refused",
        `GitHub refused a ${scope} token for ${repository}. Check the installation's repository access and accepted permissions.`,
      );
    }
    return upstreamFailure(err, "token_creation");
  }

  const singleRepo = minted.repositories.length === 1 && minted.repositories[0]?.toLowerCase() === repo.name.toLowerCase();
  const permitted = singleRepo ? await userMayMint(ctx, minted.token, repo, instance.githubUserId) : "denied";
  if (permitted !== "allowed") {
    try {
      await ctx.app.revokeInstallationToken(minted.token);
    } catch {
      audit(ctx.log, "token_rejected", {
        ...base,
        outcome: "error",
        reason: "revocation_failed",
        repository,
        scope,
        installation_id: installationId,
      });
    }
    return deny(
      403,
      permitted === "lookup_failed" ? "permission_check_failed" : "insufficient_repo_permission",
      `The linked GitHub account needs write access to ${repository}.`,
    );
  }

  audit(ctx.log, "token_issued", {
    ...base,
    outcome: "ok",
    installation_id: installationId,
    repository,
    scope,
    expires_at: minted.expiresAt,
  });
  return json(200, {
    token: minted.token,
    expires_at: minted.expiresAt,
    repository,
    scope,
    permissions: minted.permissions,
  });
}

async function userMayMint(
  ctx: Context,
  installationToken: string,
  repo: RepoRef,
  githubUserId: number,
): Promise<"allowed" | "denied" | "lookup_failed"> {
  try {
    const login = await ctx.app.userLogin(installationToken, githubUserId);
    const permission = await ctx.app.repoPermission(installationToken, repo, login);
    return REPO_ROLES_ALLOWED_TO_MINT.has(permission) ? "allowed" : "denied";
  } catch (err) {
    return err instanceof GitHubError && err.status === 404 ? "denied" : "lookup_failed";
  }
}
