import { audit, type AuditEvent } from "./audit";
import type { Context } from "./context";
import { problem } from "./http";
import type { Instance } from "./store";
import {
  canonicalString,
  decodePublicKey,
  isFresh,
  NONCE_TTL_SECONDS,
  readSignedHeaders,
  verifyEd25519,
  type SignedRequest,
} from "./signing";

export interface VerifiedInstanceRequest {
  signed: SignedRequest;
  instance: Instance;
}

function unauthorised(ctx: Context, event: AuditEvent, reason: string, instanceId?: string): Response {
  audit(ctx.log, event, { outcome: "denied", reason, instance_id: instanceId, ray: ctx.ray });
  return problem(401, reason, "The request signature could not be verified.");
}

export async function verifySignature(
  ctx: Context,
  request: Request,
  path: string,
  body: Uint8Array,
  publicKey: string,
  signed: SignedRequest,
  nonceScope: string,
  event: AuditEvent,
): Promise<Response | null> {
  if (!isFresh(signed.timestamp, ctx.nowSeconds())) {
    return unauthorised(ctx, event, "stale_request", signed.instanceId || undefined);
  }
  const rawKey = decodePublicKey(publicKey);
  const message = await canonicalString(request.method, path, signed, body);
  if (!rawKey || !(await verifyEd25519(rawKey, message, signed.signature))) {
    return unauthorised(ctx, event, "bad_signature", signed.instanceId || undefined);
  }
  const fresh = await ctx.store.consumeNonce(
    nonceScope,
    signed.nonce,
    ctx.nowSeconds() + NONCE_TTL_SECONDS,
  );
  if (!fresh) return unauthorised(ctx, event, "replayed_request", signed.instanceId || undefined);
  return null;
}

export async function verifyInstanceRequest(
  ctx: Context,
  request: Request,
  path: string,
  body: Uint8Array,
  event: AuditEvent,
): Promise<VerifiedInstanceRequest | Response> {
  const signed = readSignedHeaders(request.headers, true);
  if (typeof signed === "string") return unauthorised(ctx, event, signed);
  const instance = await ctx.store.getInstance(signed.instanceId);
  if (!instance) return unauthorised(ctx, event, "unknown_instance", signed.instanceId);
  const failure = await verifySignature(
    ctx,
    request,
    path,
    body,
    instance.publicKey,
    signed,
    `instance:${instance.instanceId}`,
    event,
  );
  return failure ?? { signed, instance };
}
