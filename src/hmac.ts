import { createHmac, timingSafeEqual } from "node:crypto";
import type { SigFormat } from "./config.js";

/**
 * x-agent-games-signature handling.
 *
 * Default: HMAC-SHA256 over the raw body bytes, lowercase hex.
 * GK_SIG_FORMAT="sha256-hex" wraps the same hex as "sha256=<hex>".
 * The algorithm is not documented by the platform; HMAC-SHA256 hex is the
 * default and the format is switchable via env if the platform turns out
 * to expect the prefixed variant.
 */
export function signBody(
  rawBody: Buffer | string,
  secret: string,
  format: SigFormat,
): string {
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  return format === "sha256-hex" ? `sha256=${hex}` : hex;
}

export function verifyBodySignature(
  rawBody: Buffer,
  providedHeader: string | undefined,
  secret: string,
  format: SigFormat,
): boolean {
  if (!providedHeader) return false;
  const expected = signBody(rawBody, secret, format);
  const a = Buffer.from(providedHeader.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
