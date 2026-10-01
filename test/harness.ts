import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Env } from "../src/config";
import { handleRequest, type Dependencies } from "../src/index";
import { TestD1 } from "./d1";
import { APP_ID, CLIENT_ID, FakeGitHub } from "./fake-github";

export const WEBHOOK_SECRET = "test-webhook-secret-not-real";
export const BASE = "https://auth.example.test";

export class Harness {
  readonly db = new TestD1();
  readonly github = new FakeGitHub();
  readonly logs: string[] = [];
  now = 1_790_000_000;
  readonly env: Env;
  private readonly deps: Dependencies;

  constructor(options: { pkcs1?: boolean; env?: Partial<Env> } = {}) {
    this.env = {
      DB: this.db as unknown as D1Database,
      GITHUB_APP_ID: String(APP_ID),
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_SLUG: "noctra-agent",
      GITHUB_BOT_USER_ID: "336615789",
      GITHUB_APP_PRIVATE_KEY: options.pkcs1 ? this.github.pkcs1Pem : this.github.pkcs8Pem,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ...options.env,
    };
    this.deps = { fetchFn: this.github.fetch, nowSeconds: () => this.now, log: (line) => this.logs.push(line) };
  }

  request(path: string, init: RequestInit = {}): Promise<Response> {
    return handleRequest(new Request(`${BASE}${path}`, init), this.env, this.deps);
  }

  webhook(event: string, payload: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    return this.request("/webhook", {
      method: "POST",
      body,
      headers: { "X-GitHub-Event": event, "X-GitHub-Delivery": "d-1", "X-Hub-Signature-256": `sha256=${signature}` },
    });
  }
}

let nonceCounter = 0;

export class Instance {
  readonly privateKey: KeyObject;
  readonly publicKeyB64: string;
  id = "";

  constructor(private readonly h: Harness) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  }

  signedHeaders(path: string, body: string, opts: { nonce?: string; timestamp?: number; instanceId?: string } = {}) {
    const timestamp = opts.timestamp ?? this.h.now;
    const nonce = opts.nonce ?? `nonce${String(++nonceCounter).padStart(16, "0")}`;
    const instanceId = opts.instanceId ?? this.id;
    const canonical = [
      "noctra-auth-v1",
      "POST",
      path,
      String(timestamp),
      nonce,
      instanceId,
      createHash("sha256").update(body).digest("hex"),
    ].join("\n");
    const signature = sign(null, Buffer.from(canonical), this.privateKey).toString("base64");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Noctra-Timestamp": String(timestamp),
      "X-Noctra-Nonce": nonce,
      "X-Noctra-Signature": signature,
    };
    if (instanceId) headers["X-Noctra-Instance"] = instanceId;
    return headers;
  }

  async link(githubToken: string, opts: { nonce?: string } = {}): Promise<Response> {
    const body = JSON.stringify({ github_token: githubToken, public_key: this.publicKeyB64 });
    const res = await this.h.request("/link", {
      method: "POST",
      body,
      headers: this.signedHeaders("/link", body, { ...opts, instanceId: "" }),
    });
    if (res.status === 201) this.id = ((await res.clone().json()) as { instance_id: string }).instance_id;
    return res;
  }

  token(repository: string, scope = "write", opts: { nonce?: string; timestamp?: number; tamper?: boolean } = {}) {
    const body = JSON.stringify({ repository, scope });
    const headers = this.signedHeaders("/token", body, opts);
    return this.h.request("/token", { method: "POST", body: opts.tamper ? body.replace(scope, "write") : body, headers });
  }

  unlink() {
    const body = "{}";
    return this.h.request("/unlink", { method: "POST", body, headers: this.signedHeaders("/unlink", body) });
  }
}
