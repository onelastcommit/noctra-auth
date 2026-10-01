import { fromBase64, sha256, toHex, utf8 } from "./encoding";

export const SIGNATURE_VERSION = "noctra-auth-v1";
export const MAX_CLOCK_SKEW_SECONDS = 120;
export const NONCE_TTL_SECONDS = 2 * MAX_CLOCK_SKEW_SECONDS + 60;

export const HEADER_INSTANCE = "X-Noctra-Instance";
export const HEADER_TIMESTAMP = "X-Noctra-Timestamp";
export const HEADER_NONCE = "X-Noctra-Nonce";
export const HEADER_SIGNATURE = "X-Noctra-Signature";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const INSTANCE_PATTERN = /^ni_[A-Za-z0-9_-]{16,64}$/;

export interface SignedRequest {
  instanceId: string;
  timestamp: number;
  nonce: string;
  signature: Uint8Array;
}

export type SignatureFailure =
  | "missing_signature_headers"
  | "malformed_signature_headers"
  | "stale_request"
  | "bad_signature";

export function readSignedHeaders(
  headers: Headers,
  requireInstance: boolean,
): SignedRequest | SignatureFailure {
  const instanceId = headers.get(HEADER_INSTANCE) ?? "";
  const timestampRaw = headers.get(HEADER_TIMESTAMP);
  const nonce = headers.get(HEADER_NONCE);
  const signatureRaw = headers.get(HEADER_SIGNATURE);
  if (!timestampRaw || !nonce || !signatureRaw || (requireInstance && !instanceId)) {
    return "missing_signature_headers";
  }
  if (!/^\d{1,12}$/.test(timestampRaw) || !NONCE_PATTERN.test(nonce)) {
    return "malformed_signature_headers";
  }
  if (requireInstance ? !INSTANCE_PATTERN.test(instanceId) : instanceId !== "") {
    return "malformed_signature_headers";
  }
  const signature = fromBase64(signatureRaw);
  if (!signature || signature.length !== 64) return "malformed_signature_headers";
  return { instanceId, timestamp: Number(timestampRaw), nonce, signature };
}

export function isFresh(timestamp: number, nowSeconds: number): boolean {
  return Math.abs(nowSeconds - timestamp) <= MAX_CLOCK_SKEW_SECONDS;
}

export async function canonicalString(
  method: string,
  path: string,
  signed: Pick<SignedRequest, "instanceId" | "timestamp" | "nonce">,
  body: Uint8Array,
): Promise<string> {
  return [
    SIGNATURE_VERSION,
    method.toUpperCase(),
    path,
    String(signed.timestamp),
    signed.nonce,
    signed.instanceId,
    toHex(await sha256(body)),
  ].join("\n");
}

export function decodePublicKey(encoded: string): Uint8Array | null {
  const raw = fromBase64(encoded);
  return raw && raw.length === 32 ? raw : null;
}

export async function verifyEd25519(
  publicKey: Uint8Array,
  message: string,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, utf8(message));
  } catch {
    return false;
  }
}
