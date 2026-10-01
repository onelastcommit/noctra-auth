import { fromBase64 } from "./encoding";

const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derNode(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const contentLength = parts.reduce((sum, p) => sum + p.length, 0);
  const length = derLength(contentLength);
  const out = new Uint8Array(1 + length.length + contentLength);
  out[0] = tag;
  out.set(length, 1);
  let offset = 1 + length.length;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  return derNode(
    0x30,
    new Uint8Array([0x02, 0x01, 0x00]),
    RSA_ENCRYPTION_ALGORITHM_IDENTIFIER,
    derNode(0x04, pkcs1),
  );
}

function pemBody(pem: string, label: string): Uint8Array | null {
  const match = pem.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`));
  return match?.[1] ? fromBase64(match[1]) : null;
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const normalised = pem.replace(/\\n/g, "\n");
  const pkcs8 = pemBody(normalised, "PRIVATE KEY");
  const pkcs1 = pkcs8 ? null : pemBody(normalised, "RSA PRIVATE KEY");
  const der = pkcs8 ?? (pkcs1 ? wrapPkcs1InPkcs8(pkcs1) : null);
  if (!der) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM-encoded RSA private key");
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
