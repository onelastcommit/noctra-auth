import { beforeEach, describe, expect, it } from "vitest";
import { APP_ID } from "./fake-github";
import { Harness, Instance } from "./harness";

const USER_TOKEN = "ghu_userAccessTokenForAlice000000000";
const ALICE = 1001;
const ORG_INSTALL = 777;
const PERSONAL_INSTALL = 888;

function setup(options?: ConstructorParameters<typeof Harness>[0]) {
  const h = new Harness(options);
  h.github.addUser(USER_TOKEN, ALICE, "alice", [
    { id: ORG_INSTALL, account: "onelastcommit" },
    { id: PERSONAL_INSTALL, account: "alice" },
    { id: 999, app_id: 1, account: "someone-else" },
  ]);
  h.github.repoInstallations.set("onelastcommit/noctra", ORG_INSTALL);
  h.github.repoInstallations.set("onelastcommit/docs", ORG_INSTALL);
  h.github.repoInstallations.set("alice/dotfiles", PERSONAL_INSTALL);
  h.github.permissions.set("onelastcommit/noctra:alice", "write");
  h.github.permissions.set("onelastcommit/docs:alice", "read");
  h.github.permissions.set("alice/dotfiles:alice", "admin");
  return h;
}

async function linked(h: Harness) {
  const instance = new Instance(h);
  expect((await instance.link(USER_TOKEN)).status).toBe(201);
  return instance;
}

function assertNoSecretsLogged(h: Harness) {
  const logs = h.logs.join("\n");
  expect(logs).not.toContain(USER_TOKEN);
  expect(logs).not.toMatch(/ghs_/);
  expect(logs).not.toContain("PRIVATE KEY");
  for (const line of h.logs) expect(() => JSON.parse(line)).not.toThrow();
}

describe("GET /config", () => {
  it("publishes the app's public identity", async () => {
    const h = setup();
    const body = await (await h.request("/config")).json();
    expect(body).toMatchObject({
      app_id: APP_ID,
      slug: "noctra-agent",
      install_url: "https://github.com/apps/noctra-agent/installations/new",
      bot: { login: "noctra-agent[bot]", id: 336615789, email: "336615789+noctra-agent[bot]@users.noreply.github.com" },
    });
  });

  it("refuses to serve when misconfigured", async () => {
    const h = setup({ env: { GITHUB_WEBHOOK_SECRET: "" } });
    expect((await h.request("/config")).status).toBe(500);
  });
});

describe("POST /link", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it("links an instance to the app's installations only and never stores the user token", async () => {
    const instance = new Instance(h);
    const res = await instance.link(USER_TOKEN);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { instance_id: string; installations: { id: number }[] };
    expect(body.instance_id).toMatch(/^ni_/);
    expect(body.installations.map((i) => i.id)).toEqual([ORG_INSTALL, PERSONAL_INSTALL]);
    expect(h.db.dump()).not.toContain(USER_TOKEN);
    expect(h.db.dump()).not.toContain("alice");
    expect(h.db.count("instance_installations")).toBe(2);
    assertNoSecretsLogged(h);
  });

  it("rejects a bad signature", async () => {
    const instance = new Instance(h);
    const other = new Instance(h);
    const body = JSON.stringify({ github_token: USER_TOKEN, public_key: instance.publicKeyB64 });
    const res = await h.request("/link", { method: "POST", body, headers: other.signedHeaders("/link", body, { instanceId: "" }) });
    expect(res.status).toBe(401);
    expect(h.db.count("instances")).toBe(0);
  });

  it("rejects a replayed link request", async () => {
    const instance = new Instance(h);
    expect((await instance.link(USER_TOKEN, { nonce: "replayednonce00000001" })).status).toBe(201);
    h.db.raw.exec("DELETE FROM instance_installations; DELETE FROM instances");
    expect((await instance.link(USER_TOKEN, { nonce: "replayednonce00000001" })).status).toBe(401);
  });

  it("rejects an invalid GitHub token", async () => {
    const res = await new Instance(h).link("ghu_notARealTokenAtAll0000000000");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_github_token");
  });

  it("asks the user to install the app when they have no installations", async () => {
    h.github.addUser("ghu_bobHasNothingInstalled0000000", 2002, "bob", []);
    const res = await new Instance(h).link("ghu_bobHasNothingInstalled0000000");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_installations", install_url: expect.stringContaining("noctra-agent") });
  });

  it("refuses to link the same public key twice", async () => {
    const instance = await linked(h);
    instance.id = "";
    expect((await instance.link(USER_TOKEN)).status).toBe(409);
  });

  it("caps instances per user", async () => {
    h = setup({ env: { MAX_INSTANCES_PER_USER: "2" } });
    await linked(h);
    await linked(h);
    const res = await new Instance(h).link(USER_TOKEN);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("too_many_instances");
  });

  it("rate limits link attempts per client address", async () => {
    h = setup({ env: { LINK_REQUESTS_PER_HOUR: "1" } });
    await linked(h);
    expect((await new Instance(h).link(USER_TOKEN)).status).toBe(429);
  });
});

describe("POST /token", () => {
  let h: Harness;
  let instance: Instance;
  beforeEach(async () => {
    h = setup();
    instance = await linked(h);
  });

  it("mints a write token scoped to one repository", async () => {
    const res = await instance.token("onelastcommit/noctra", "write");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_at: string; permissions: Record<string, string> };
    expect(body.expires_at).toBe("2026-10-01T13:00:00Z");
    const issued = h.github.issued.get(body.token)!;
    expect(issued.installationId).toBe(ORG_INSTALL);
    expect(issued.repositories).toEqual(["noctra"]);
    expect(issued.permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      statuses: "read",
      actions: "read",
      metadata: "read",
    });
    expect(issued.permissions).not.toHaveProperty("workflows");
    expect(h.github.revoked.size).toBe(0);
    expect(h.logs.some((l) => l.includes('"event":"token_issued"'))).toBe(true);
    assertNoSecretsLogged(h);
  });

  it("mints the narrower git and read scopes", async () => {
    const git = (await (await instance.token("onelastcommit/noctra", "git")).json()) as { token: string };
    expect(h.github.issued.get(git.token)!.permissions).toEqual({ contents: "write", metadata: "read" });
    const read = (await (await instance.token("alice/dotfiles", "read")).json()) as { token: string };
    const perms = h.github.issued.get(read.token)!.permissions;
    expect(Object.values(perms).every((p) => p === "read")).toBe(true);
  });

  it("rejects a replayed request", async () => {
    expect((await instance.token("onelastcommit/noctra", "write", { nonce: "samenonce000000000001" })).status).toBe(200);
    const replay = await instance.token("onelastcommit/noctra", "write", { nonce: "samenonce000000000001" });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toBe("replayed_request");
  });

  it("rejects stale and future timestamps", async () => {
    expect((await instance.token("onelastcommit/noctra", "write", { timestamp: h.now - 121 })).status).toBe(401);
    expect((await instance.token("onelastcommit/noctra", "write", { timestamp: h.now + 121 })).status).toBe(401);
    expect((await instance.token("onelastcommit/noctra", "write", { timestamp: h.now - 100 })).status).toBe(200);
  });

  it("rejects a body that does not match the signature", async () => {
    const res = await instance.token("onelastcommit/noctra", "read", { tamper: true });
    expect(res.status).toBe(401);
    expect(h.github.issued.size).toBe(0);
  });

  it("rejects an unknown instance", async () => {
    instance.id = "ni_doesNotExist000000000";
    expect((await instance.token("onelastcommit/noctra")).status).toBe(401);
  });

  it("rejects malformed requests", async () => {
    expect((await instance.token("onelastcommit/noctra", "admin")).status).toBe(400);
    expect((await instance.token("not-a-repo", "write")).status).toBe(400);
    expect((await instance.token("a/b/c", "write")).status).toBe(400);
  });

  it("reports repositories where the app is not installed", async () => {
    const res = await instance.token("onelastcommit/secret", "write");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_installed");
  });

  it("refuses installations the instance is not linked to", async () => {
    h.github.repoInstallations.set("other/repo", 4242);
    const res = await instance.token("other/repo", "write");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("installation_not_linked");
    expect(h.github.issued.size).toBe(0);
  });

  it("refuses and revokes when the user cannot push to the repository", async () => {
    const res = await instance.token("onelastcommit/docs", "read");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_repo_permission");
    expect(h.github.issued.size).toBe(1);
    expect(h.github.revoked.size).toBe(1);
  });

  it("refuses and revokes when the user is not a collaborator at all", async () => {
    h.github.repoInstallations.set("onelastcommit/private", ORG_INSTALL);
    const res = await instance.token("onelastcommit/private", "write");
    expect(res.status).toBe(403);
    expect(h.github.revoked.size).toBe(1);
  });

  it("surfaces GitHub refusing the token", async () => {
    h.github.refusedInstallations.add(ORG_INSTALL);
    const res = await instance.token("onelastcommit/noctra", "write");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("installation_refused");
  });

  it("returns 502 when GitHub is failing", async () => {
    h.github.failInstallationLookup = true;
    expect((await instance.token("onelastcommit/noctra", "write")).status).toBe(502);
  });

  it("rate limits per instance", async () => {
    h = setup({ env: { TOKEN_REQUESTS_PER_MINUTE: "2" } });
    instance = await linked(h);
    expect((await instance.token("onelastcommit/noctra")).status).toBe(200);
    expect((await instance.token("onelastcommit/noctra")).status).toBe(200);
    const limited = await instance.token("onelastcommit/noctra");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    h.now += 60;
    expect((await instance.token("onelastcommit/noctra")).status).toBe(200);
  });

  it("works with a PKCS#1 private key as downloaded from GitHub", async () => {
    h = setup({ pkcs1: true });
    instance = await linked(h);
    expect((await instance.token("onelastcommit/noctra")).status).toBe(200);
  });

  it("never caches responses", async () => {
    const res = await instance.token("onelastcommit/noctra");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /unlink", () => {
  it("revokes the instance", async () => {
    const h = setup();
    const instance = await linked(h);
    expect((await instance.unlink()).status).toBe(200);
    expect(h.db.count("instances")).toBe(0);
    expect(h.db.count("instance_installations")).toBe(0);
    expect((await instance.token("onelastcommit/noctra")).status).toBe(401);
  });
});

describe("POST /webhook", () => {
  let h: Harness;
  let instance: Instance;
  beforeEach(async () => {
    h = setup();
    instance = await linked(h);
  });

  it("rejects a bad signature", async () => {
    const res = await h.webhook("installation", { action: "deleted", installation: { id: ORG_INSTALL } }, "wrong-secret");
    expect(res.status).toBe(401);
    expect(h.db.count("instance_installations")).toBe(2);
  });

  it("drops links when the app is uninstalled", async () => {
    const res = await h.webhook("installation", {
      action: "deleted",
      installation: { id: ORG_INSTALL, app_id: APP_ID },
      sender: { id: ALICE },
    });
    expect(res.status).toBe(200);
    expect(h.db.count("instance_installations")).toBe(1);
    expect(((await (await instance.token("onelastcommit/noctra")).json()) as { error: string }).error).toBe(
      "installation_not_linked",
    );
    expect((await instance.token("alice/dotfiles")).status).toBe(200);
  });

  it("links a new installation to the installing user's instances", async () => {
    h.github.repoInstallations.set("alice/newrepo", 5555);
    h.github.permissions.set("alice/newrepo:alice", "admin");
    expect((await instance.token("alice/newrepo")).status).toBe(403);
    await h.webhook("installation", { action: "created", installation: { id: 5555, app_id: APP_ID }, sender: { id: ALICE } });
    expect((await instance.token("alice/newrepo")).status).toBe(200);
  });

  it("removes every instance when the user revokes the app's authorisation", async () => {
    await linked(h);
    await h.webhook("github_app_authorization", { action: "revoked", sender: { id: ALICE } });
    expect(h.db.count("instances")).toBe(0);
    expect(h.db.count("instance_installations")).toBe(0);
  });

  it("acknowledges repository removals without storing repositories", async () => {
    const res = await h.webhook("installation_repositories", {
      action: "removed",
      installation: { id: ORG_INSTALL, app_id: APP_ID },
      repositories_removed: [{ full_name: "onelastcommit/noctra" }],
      sender: { id: ALICE },
    });
    expect(res.status).toBe(200);
    expect(h.db.count("instance_installations")).toBe(2);
  });

  it("ignores events for a different app", async () => {
    const res = await h.webhook("installation", { action: "deleted", installation: { id: ORG_INSTALL, app_id: 1 } });
    expect(res.status).toBe(202);
    expect(h.db.count("instance_installations")).toBe(2);
  });
});

describe("routing", () => {
  it("serves the post-install page without reflecting the OAuth code", async () => {
    const h = setup();
    const res = await h.request("/installed?code=sensitive-oauth-code&installation_id=1");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("noctra github login");
    expect(text).not.toContain("sensitive-oauth-code");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("rejects oversized bodies and unknown routes", async () => {
    const h = setup();
    expect((await h.request("/token", { method: "POST", body: "x".repeat(17 * 1024) })).status).toBe(413);
    expect((await h.request("/nope")).status).toBe(404);
    expect((await h.request("/token", { method: "PUT" })).status).toBe(405);
  });
});

describe("purge", () => {
  it("removes expired nonces and rate-limit windows", async () => {
    const h = setup();
    const instance = await linked(h);
    await instance.token("onelastcommit/noctra");
    expect(h.db.count("nonces")).toBe(2);
    const { purgeExpired } = await import("../src/index");
    h.now += 3 * 3600;
    await purgeExpired(h.env, { fetchFn: h.github.fetch, nowSeconds: () => h.now, log: () => {} });
    expect(h.db.count("nonces")).toBe(0);
    expect(h.db.count("rate_limits")).toBe(0);
  });
});
