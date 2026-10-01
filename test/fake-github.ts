import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

export const APP_ID = 5151968;
export const CLIENT_ID = "Iv23liTestClientId0001";

interface User {
  id: number;
  login: string;
  installations: { id: number; app_id: number; account: { login: string } }[];
}

export class FakeGitHub {
  readonly pkcs8Pem: string;
  readonly pkcs1Pem: string;
  private readonly publicKey: KeyObject;
  readonly users = new Map<string, User>();
  readonly usersById = new Map<number, User>();
  readonly repoInstallations = new Map<string, number>();
  readonly permissions = new Map<string, string>();
  readonly issued = new Map<string, { installationId: number; repositories: string[]; permissions: Record<string, string> }>();
  readonly revoked = new Set<string>();
  readonly refusedInstallations = new Set<number>();
  failInstallationLookup = false;
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    this.publicKey = publicKey;
  }

  addUser(token: string, id: number, login: string, installations: { id: number; app_id?: number; account?: string }[]) {
    const user: User = {
      id,
      login,
      installations: installations.map((i) => ({ id: i.id, app_id: i.app_id ?? APP_ID, account: { login: i.account ?? login } })),
    };
    this.users.set(token, user);
    this.usersById.set(id, user);
  }

  private appJwtValid(authorization: string | null): boolean {
    const jwt = authorization?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");
    if (!header || !payload || !signature) return false;
    const ok = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.publicKey, Buffer.from(signature, "base64url"));
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return ok && claims.iss === CLIENT_ID && claims.exp > claims.iat;
  }

  private installationToken(authorization: string | null) {
    const token = authorization?.replace(/^token /, "") ?? "";
    return this.revoked.has(token) ? undefined : this.issued.get(token);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("Authorization");
    const path = url.pathname;
    const reply = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });

    if (path === "/user" && method === "GET") {
      const user = this.users.get(auth?.replace(/^Bearer /, "") ?? "");
      return user ? reply(200, { id: user.id, login: user.login }) : reply(401, { message: "Bad credentials" });
    }
    if (path === "/user/installations") {
      const user = this.users.get(auth?.replace(/^Bearer /, "") ?? "");
      return user
        ? reply(200, { total_count: user.installations.length, installations: user.installations })
        : reply(401, {});
    }
    let m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
    if (m) {
      if (!this.appJwtValid(auth)) return reply(401, {});
      if (this.failInstallationLookup) return reply(500, {});
      const id = this.repoInstallations.get(`${m[1]}/${m[2]}`.toLowerCase());
      return id ? reply(200, { id }) : reply(404, {});
    }
    m = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (m && method === "POST") {
      if (!this.appJwtValid(auth)) return reply(401, {});
      const installationId = Number(m[1]);
      if (this.refusedInstallations.has(installationId)) return reply(422, {});
      const body = JSON.parse(String(init?.body));
      const token = `ghs_fake${String(++this.counter).padStart(32, "0")}`;
      this.issued.set(token, { installationId, repositories: body.repositories, permissions: body.permissions });
      return reply(201, {
        token,
        expires_at: "2026-10-01T13:00:00Z",
        permissions: body.permissions,
        repositories: body.repositories.map((name: string) => ({ name })),
      });
    }
    if (path === "/installation/token" && method === "DELETE") {
      const token = auth?.replace(/^token /, "") ?? "";
      this.revoked.add(token);
      return reply(204);
    }
    m = path.match(/^\/user\/(\d+)$/);
    if (m) {
      if (!this.installationToken(auth)) return reply(401, {});
      const user = this.usersById.get(Number(m[1]));
      return user ? reply(200, { id: user.id, login: user.login }) : reply(404, {});
    }
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/);
    if (m) {
      const tokenInfo = this.installationToken(auth);
      if (!tokenInfo || !tokenInfo.repositories.includes(m[2]!)) return reply(403, {});
      const permission = this.permissions.get(`${m[1]}/${m[2]}:${decodeURIComponent(m[3]!)}`);
      return permission ? reply(200, { permission }) : reply(404, {});
    }
    return reply(404, { message: `unexpected ${method} ${path}` });
  };
}
