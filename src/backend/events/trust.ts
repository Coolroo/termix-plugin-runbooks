/**
 * Which certificates an http item trusts (1.4.10, phase 3): Node's public
 * roots, plus the admin setting "Extra trusted CAs" (PEM, one or more
 * certificates), used only by Runbooks' http checks. Termix trusts the
 * public roots only (phase 0), so a home CA's certificates need the
 * setting. The check is never skipped: there is no setting that turns it
 * off, and no rejectUnauthorized: false anywhere in the events.
 */

import crypto from "node:crypto";
import tls from "node:tls";

/** The admin setting's key. */
export const HTTP_CA_SETTING = "httpCaPem";

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The certificates in a PEM text, each as its own PEM block. */
export function pemBlocks(text: string): string[] {
  return text.match(PEM_BLOCK) ?? [];
}

/**
 * Why the setting's text is refused, or null: empty is fine (no extra
 * CA); otherwise one or more PEM certificates that Node can read, and
 * nothing else (no private key).
 */
export function caBundleProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "Paste PEM certificates as text";
  if (/PRIVATE KEY/.test(value)) {
    return "This holds a private key: paste the CA certificates only";
  }
  const blocks = pemBlocks(value);
  if (blocks.length === 0) {
    return "Paste one or more certificates, each from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----";
  }
  if (blocks.length > 50) return "At most 50 certificates";
  for (const [index, block] of blocks.entries()) {
    try {
      new crypto.X509Certificate(block);
    } catch {
      return `Certificate ${index + 1} cannot be read`;
    }
  }
  return null;
}

/**
 * The CAs an http check trusts: the public roots and the setting's
 * certificates. A setting that cannot be read adds nothing: the public
 * roots stay.
 */
export function trustedCas(extra: unknown): string[] {
  const roots = [...tls.rootCertificates];
  if (typeof extra !== "string" || caBundleProblem(extra) !== null) {
    return roots;
  }
  return [...roots, ...pemBlocks(extra)];
}
