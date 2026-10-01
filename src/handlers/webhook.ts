import { audit, type AuditFields } from "../audit";
import type { Context } from "../context";
import { constantTimeEqual, fromHex, utf8 } from "../encoding";
import { json, parseJsonObject, problem } from "../http";

export async function verifyWebhookSignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = fromHex(header.slice("sha256=".length));
  if (!expected || expected.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return constantTimeEqual(actual, expected);
}

function numberAt(value: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isInteger(cursor) ? cursor : undefined;
}

export async function handleWebhook(ctx: Context, request: Request, body: Uint8Array): Promise<Response> {
  const event = request.headers.get("X-GitHub-Event") ?? "";
  const deliveryId = (request.headers.get("X-GitHub-Delivery") ?? "").slice(0, 64);
  const base: AuditFields = { outcome: "ok", github_event: event, delivery_id: deliveryId, ray: ctx.ray };

  if (!(await verifyWebhookSignature(ctx.config.webhookSecret, body, request.headers.get("X-Hub-Signature-256")))) {
    audit(ctx.log, "webhook_rejected", { ...base, outcome: "denied", reason: "bad_signature" });
    return problem(401, "bad_signature", "Webhook signature did not match.");
  }

  const payload = parseJsonObject(body);
  if (!payload) {
    audit(ctx.log, "webhook_rejected", { ...base, outcome: "denied", reason: "invalid_payload" });
    return problem(400, "invalid_payload", "Webhook body was not a JSON object.");
  }
  const action = typeof payload.action === "string" ? payload.action : "";
  const installationId = numberAt(payload, "installation", "id");
  const senderId = numberAt(payload, "sender", "id");
  const appId = numberAt(payload, "installation", "app_id");
  const fields: AuditFields = { ...base, github_action: action, installation_id: installationId };

  if (appId !== undefined && appId !== ctx.config.appId) {
    audit(ctx.log, "webhook_rejected", { ...fields, outcome: "denied", reason: "foreign_app" });
    return json(202, { ignored: true });
  }

  let affected = 0;
  if (event === "installation" && installationId !== undefined) {
    if (action === "deleted") {
      affected = await ctx.store.unlinkInstallation(installationId);
    } else if (action === "created" && senderId !== undefined) {
      affected = await ctx.store.linkInstallationForUser(senderId, installationId);
    }
  } else if (event === "github_app_authorization" && action === "revoked" && senderId !== undefined) {
    affected = await ctx.store.deleteInstancesForUser(senderId);
    audit(ctx.log, "webhook", { ...fields, github_user_id: senderId, affected });
    return json(200, { ok: true });
  }

  audit(ctx.log, "webhook", { ...fields, affected });
  return json(200, { ok: true });
}
