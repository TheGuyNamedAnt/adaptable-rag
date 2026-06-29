import { createHmac, timingSafeEqual } from "node:crypto";

import type { RequestPrincipal } from "./access-scope.js";

export interface PrincipalNormalizationContext {
  readonly tenantId: string;
  readonly namespaceId: string;
}

export interface SignedPrincipalPayload {
  readonly principal: RequestPrincipal;
  readonly issuedAt?: string;
  readonly issuer?: string;
}

export interface SignedPrincipalVerificationOptions {
  readonly maxAgeMs?: number;
  readonly clockSkewMs?: number;
  readonly nowMs?: () => number;
  readonly expectedIssuer?: string;
}

export class PrincipalResolutionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PrincipalResolutionError";
    this.statusCode = statusCode;
  }
}

export function normalizeRequestPrincipal(
  value: unknown,
  context: PrincipalNormalizationContext
): RequestPrincipal {
  if (!isRecord(value)) {
    throw new PrincipalResolutionError("principal must be a JSON object.");
  }

  const principal = {
    userId: requiredString(value["userId"], "principal.userId"),
    tenantId: requiredString(value["tenantId"], "principal.tenantId"),
    namespaceIds: requiredStringArray(value["namespaceIds"], "principal.namespaceIds"),
    teamIds: optionalStringArray(value["teamIds"], "principal.teamIds") ?? [],
    roles: optionalStringArray(value["roles"], "principal.roles") ?? [],
    tags: optionalStringArray(value["tags"], "principal.tags") ?? []
  };

  if (principal.tenantId !== context.tenantId) {
    throw new PrincipalResolutionError("principal.tenantId must match tenantId.");
  }

  if (!principal.namespaceIds.includes(context.namespaceId)) {
    throw new PrincipalResolutionError("principal.namespaceIds must include namespaceId.");
  }

  return principal;
}

export function encodeSignedPrincipalPayload(payload: SignedPrincipalPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function signPrincipalPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifySignedPrincipalPayload(input: {
  readonly payload: string;
  readonly signature: string;
  readonly secrets: readonly string[];
  readonly context: PrincipalNormalizationContext;
  readonly verification?: SignedPrincipalVerificationOptions;
}): RequestPrincipal {
  if (input.secrets.length === 0) {
    throw new PrincipalResolutionError("Principal signing secret is not configured.", 500);
  }

  if (!signatureMatches(input.payload, input.signature, input.secrets)) {
    throw new PrincipalResolutionError("Signed principal header signature is invalid.", 401);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input.payload, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new PrincipalResolutionError("Signed principal header payload must be base64url JSON.");
  }

  const envelope = isRecord(decoded) && isRecord(decoded["principal"]) ? decoded : undefined;
  if (!envelope) {
    throw new PrincipalResolutionError("Signed principal header must include principal.");
  }

  verifySignedPrincipalEnvelope(envelope, input.verification);

  return normalizeRequestPrincipal(envelope["principal"], input.context);
}

function verifySignedPrincipalEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  verification: SignedPrincipalVerificationOptions | undefined
): void {
  if (verification === undefined) {
    return;
  }

  if (
    verification.expectedIssuer !== undefined &&
    envelope["issuer"] !== verification.expectedIssuer
  ) {
    throw new PrincipalResolutionError("Signed principal header issuer is invalid.", 401);
  }

  if (verification.maxAgeMs === undefined) {
    return;
  }

  const issuedAt = envelope["issuedAt"];
  if (typeof issuedAt !== "string" || !issuedAt.trim()) {
    throw new PrincipalResolutionError("Signed principal header must include issuedAt.", 401);
  }

  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new PrincipalResolutionError("Signed principal header issuedAt is invalid.", 401);
  }

  const nowMs = verification.nowMs?.() ?? Date.now();
  const clockSkewMs = verification.clockSkewMs ?? 60_000;
  if (issuedAtMs - nowMs > clockSkewMs) {
    throw new PrincipalResolutionError("Signed principal header issuedAt is in the future.", 401);
  }
  if (nowMs - issuedAtMs > verification.maxAgeMs + clockSkewMs) {
    throw new PrincipalResolutionError("Signed principal header has expired.", 401);
  }
}

function signatureMatches(payload: string, signature: string, secrets: readonly string[]): boolean {
  const provided = cleanSignature(signature);
  if (!/^[a-f0-9]{64}$/iu.test(provided)) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, "hex");
  return secrets.some((secret) => {
    const expected = Buffer.from(signPrincipalPayload(payload, secret), "hex");
    return expected.length === providedBuffer.length && timingSafeEqual(expected, providedBuffer);
  });
}

function cleanSignature(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PrincipalResolutionError(`${path} is required.`);
  }
  return value.trim();
}

function requiredStringArray(value: unknown, path: string): readonly string[] {
  const result = optionalStringArray(value, path);
  if (!result || result.length === 0) {
    throw new PrincipalResolutionError(`${path} must contain at least one value.`);
  }
  return result;
}

function optionalStringArray(value: unknown, path: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new PrincipalResolutionError(`${path} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
