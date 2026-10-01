import { toBase64Url, utf8 } from "./encoding";
import { importAppPrivateKey } from "./keys";
import type { InstallationPermissions, RepoRef } from "./permissions";

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const API_VERSION = "2022-11-28";
const USER_AGENT = "noctra-auth";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`GitHub ${operation} failed with HTTP ${status}`);
  }
}

export interface InstallationSummary {
  id: number;
  account: string;
}

export interface MintedToken {
  token: string;
  expiresAt: string;
  repositories: string[];
  permissions: InstallationPermissions;
}

function headers(authorization: string, extra: Record<string, string> = {}): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
    ...extra,
  };
}

async function request<T>(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<T> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubError(response.status, operation);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface GitHubAppConfig {
  apiUrl: string;
  clientId: string;
  privateKeyPem: string;
}

const importedKeys = new Map<string, Promise<CryptoKey>>();

export class GitHubApp {
  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchFn: FetchFn,
    private readonly nowSeconds: () => number,
  ) {}

  private key(): Promise<CryptoKey> {
    let key = importedKeys.get(this.config.privateKeyPem);
    if (!key) {
      key = importAppPrivateKey(this.config.privateKeyPem);
      key.catch(() => importedKeys.delete(this.config.privateKeyPem));
      importedKeys.set(this.config.privateKeyPem, key);
    }
    return key;
  }

  async jwt(): Promise<string> {
    const now = this.nowSeconds();
    const header = toBase64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = toBase64Url(
      utf8(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.clientId })),
    );
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      await this.key(),
      utf8(signingInput),
    );
    return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
  }

  async repoInstallationId(repo: RepoRef): Promise<number | null> {
    try {
      const body = await request<{ id: number }>(
        this.fetchFn,
        `${this.config.apiUrl}/repos/${repo.owner}/${repo.name}/installation`,
        { headers: headers(`Bearer ${await this.jwt()}`) },
        "repository installation lookup",
      );
      return body.id;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    permissions: InstallationPermissions,
  ): Promise<MintedToken> {
    const body = await request<{
      token: string;
      expires_at: string;
      permissions: InstallationPermissions;
      repositories?: { name: string }[];
    }>(
      this.fetchFn,
      `${this.config.apiUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: headers(`Bearer ${await this.jwt()}`, { "Content-Type": "application/json" }),
        body: JSON.stringify({ repositories: [repo.name], permissions }),
      },
      "installation token creation",
    );
    return {
      token: body.token,
      expiresAt: body.expires_at,
      repositories: (body.repositories ?? []).map((r) => r.name),
      permissions: body.permissions,
    };
  }

  async revokeInstallationToken(token: string): Promise<void> {
    await request<void>(
      this.fetchFn,
      `${this.config.apiUrl}/installation/token`,
      { method: "DELETE", headers: headers(`token ${token}`) },
      "installation token revocation",
    );
  }

  async userLogin(installationToken: string, githubUserId: number): Promise<string> {
    const body = await request<{ login: string }>(
      this.fetchFn,
      `${this.config.apiUrl}/user/${githubUserId}`,
      { headers: headers(`token ${installationToken}`) },
      "user lookup",
    );
    return body.login;
  }

  async repoPermission(installationToken: string, repo: RepoRef, login: string): Promise<string> {
    const body = await request<{ permission: string }>(
      this.fetchFn,
      `${this.config.apiUrl}/repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
      { headers: headers(`token ${installationToken}`) },
      "collaborator permission lookup",
    );
    return body.permission;
  }
}

export class GitHubUser {
  constructor(
    private readonly apiUrl: string,
    private readonly userToken: string,
    private readonly fetchFn: FetchFn,
  ) {}

  async identity(): Promise<{ id: number; login: string }> {
    const body = await request<{ id: number; login: string }>(
      this.fetchFn,
      `${this.apiUrl}/user`,
      { headers: headers(`Bearer ${this.userToken}`) },
      "user identity",
    );
    return { id: body.id, login: body.login };
  }

  async installationsOfApp(appId: number): Promise<InstallationSummary[]> {
    const out: InstallationSummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await request<{
        total_count: number;
        installations: { id: number; app_id: number; account: { login: string } | null }[];
      }>(
        this.fetchFn,
        `${this.apiUrl}/user/installations?per_page=100&page=${page}`,
        { headers: headers(`Bearer ${this.userToken}`) },
        "user installations",
      );
      for (const inst of body.installations) {
        if (inst.app_id === appId) out.push({ id: inst.id, account: inst.account?.login ?? "" });
      }
      if (body.installations.length < 100) break;
    }
    return out;
  }
}
