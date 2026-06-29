import { NextResponse, type NextRequest } from "next/server";

type AdminPermission =
  | "rag:read"
  | "rag:answer"
  | "rag:ingest"
  | "rag:upload"
  | "rag:connector:write"
  | "rag:review:write"
  | "rag:admin";

interface AdminAuthDecision {
  readonly allowed: boolean;
  readonly status: number;
  readonly errorName?: string;
  readonly message?: string;
  readonly roles?: readonly string[];
  readonly permission?: AdminPermission;
}

const ADMIN_API_PREFIX = "/api/rag";
const STATIC_PATH_PREFIXES = ["/_next/static", "/_next/image"] as const;
const ROLE_PERMISSIONS: Readonly<Record<string, readonly AdminPermission[]>> = {
  viewer: ["rag:read"],
  analyst: ["rag:read", "rag:answer"],
  operator: [
    "rag:read",
    "rag:answer",
    "rag:ingest",
    "rag:upload",
    "rag:connector:write",
    "rag:review:write"
  ],
  admin: [
    "rag:read",
    "rag:answer",
    "rag:ingest",
    "rag:upload",
    "rag:connector:write",
    "rag:review:write",
    "rag:admin"
  ]
};

export async function proxy(request: NextRequest) {
  if (isStaticPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const decision: AdminAuthDecision = await authorizeAdminApiRequest(request).catch(
    (error: unknown): AdminAuthDecision => ({
      allowed: false,
      status: 500,
      errorName: "AdminApiAuthConfigurationError",
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : "Admin API auth configuration is invalid."
    })
  );
  if (!decision.allowed) {
    return deniedResponse(request, decision);
  }

  const headers = new Headers(request.headers);
  headers.set("x-rag-admin-authenticated", "true");
  headers.set("x-rag-admin-required-permission", decision.permission ?? "rag:read");
  headers.set("x-rag-admin-role-count", String(decision.roles?.length ?? 0));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"]
};

async function authorizeAdminApiRequest(request: NextRequest): Promise<AdminAuthDecision> {
  const mode = adminAuthMode();
  const permission = requiredPermission(request.method, request.nextUrl.pathname);
  if (mode === "disabled") {
    return { allowed: true, status: 200, permission, roles: ["admin"] };
  }

  const tokenDecision = await authenticateBearerToken(request);
  const proxyDecision = authenticateTrustedProxyPrincipal(request);
  if (!tokenDecision.allowed && !proxyDecision.allowed) {
    return tokenDecision.configured || proxyDecision.configured
      ? {
          allowed: false,
          status: 401,
          errorName: "AdminApiUnauthorized",
          message: "Admin API authentication is required.",
          permission
        }
      : {
          allowed: false,
          status: 500,
          errorName: "AdminApiAuthNotConfigured",
          message:
            "Admin API auth is required, but no admin token or trusted proxy mode is configured.",
          permission
        };
  }

  const roles = uniqueSorted([...tokenDecision.roles, ...proxyDecision.roles]);
  if (!rolesCan(roles, permission)) {
    return {
      allowed: false,
      status: 403,
      errorName: "AdminApiForbidden",
      message: `Admin role does not include ${permission}.`,
      permission,
      roles
    };
  }

  return { allowed: true, status: 200, permission, roles };
}

function adminAuthMode(): "required" | "disabled" {
  const configured = process.env.RAG_ADMIN_AUTH_MODE?.trim();
  if (configured === "required" || configured === "disabled") {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? "required" : "disabled";
}

function requiredPermission(method: string, pathname: string): AdminPermission {
  if (method === "GET" || method === "HEAD") {
    return "rag:read";
  }
  if (pathname.includes("/answer")) {
    return "rag:answer";
  }
  if (pathname.includes("/uploads")) {
    return "rag:upload";
  }
  if (pathname.includes("/connectors/actions")) {
    return "rag:connector:write";
  }
  if (pathname.includes("/review")) {
    return "rag:review:write";
  }
  if (pathname.includes("/ingestion") || pathname.includes("/production-setup")) {
    return "rag:ingest";
  }
  return "rag:admin";
}

async function authenticateBearerToken(request: NextRequest): Promise<{
  readonly allowed: boolean;
  readonly configured: boolean;
  readonly roles: readonly string[];
}> {
  const expected = await adminTokenHashes();
  if (expected.length === 0) {
    return { allowed: false, configured: false, roles: [] };
  }

  const token = bearerToken(request, process.env.RAG_ADMIN_AUTH_HEADER ?? "authorization");
  if (token === undefined) {
    return { allowed: false, configured: true, roles: [] };
  }

  const actual = await sha256Hex(token);
  const allowed = expected.some((hash) => secureHexEqual(actual, hash));
  return {
    allowed,
    configured: true,
    roles: allowed ? csvEnv("RAG_ADMIN_TOKEN_ROLES", ["admin"]) : []
  };
}

function authenticateTrustedProxyPrincipal(request: NextRequest): {
  readonly allowed: boolean;
  readonly configured: boolean;
  readonly roles: readonly string[];
} {
  if (process.env.RAG_ADMIN_TRUSTED_PROXY_MODE !== "enabled") {
    return { allowed: false, configured: false, roles: [] };
  }

  const principalHeader = process.env.RAG_ADMIN_PRINCIPAL_HEADER ?? "x-rag-admin-principal";
  const rolesHeader = process.env.RAG_ADMIN_ROLES_HEADER ?? "x-rag-admin-roles";
  const principal = request.headers.get(principalHeader)?.trim();
  const roles = csvHeader(request.headers.get(rolesHeader));
  return {
    allowed: Boolean(principal) && roles.length > 0,
    configured: true,
    roles
  };
}

async function adminTokenHashes(): Promise<readonly string[]> {
  const hashCsv = process.env.RAG_ADMIN_AUTH_TOKEN_SHA256S?.trim();
  if (hashCsv) {
    return hashCsv
      .split(",")
      .map((value) => normalizeSha256Hex(value, "RAG_ADMIN_AUTH_TOKEN_SHA256S"));
  }

  const tokenEnvNames = csvEnv("RAG_ADMIN_AUTH_TOKEN_ENVS", []);
  const singleEnvName = process.env.RAG_ADMIN_AUTH_TOKEN_ENV?.trim();
  const names = tokenEnvNames.length > 0 ? tokenEnvNames : singleEnvName ? [singleEnvName] : [];
  if (names.length > 0) {
    return Promise.all(
      names
        .map((name) => process.env[name]?.trim())
        .filter((value): value is string => Boolean(value))
        .map((value) => sha256Hex(value))
    );
  }

  const directToken = process.env.RAG_ADMIN_AUTH_TOKEN?.trim();
  return directToken ? [await sha256Hex(directToken)] : [];
}

function bearerToken(request: NextRequest, headerName: string): string | undefined {
  const value = request.headers.get(headerName.toLowerCase())?.trim();
  if (!value) {
    return undefined;
  }
  if (headerName.toLowerCase() === "authorization") {
    const match = /^Bearer\s+(.+)$/iu.exec(value);
    return match?.[1]?.trim() || undefined;
  }
  return value;
}

function deniedResponse(request: NextRequest, decision: AdminAuthDecision): NextResponse {
  const body = {
    error: {
      name: decision.errorName ?? "AdminApiUnauthorized",
      message: decision.message ?? "Admin access denied."
    }
  };
  const headers = decision.status === 401 ? { "www-authenticate": "Bearer" } : undefined;
  if (request.nextUrl.pathname.startsWith(ADMIN_API_PREFIX)) {
    return NextResponse.json(body, { status: decision.status, headers });
  }

  return new NextResponse(body.error.message, {
    status: decision.status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(headers ?? {})
    }
  });
}

function rolesCan(roles: readonly string[], permission: AdminPermission): boolean {
  return roles.some((role) => {
    const permissions = ROLE_PERMISSIONS[role] ?? [];
    return permissions.includes("rag:admin") || permissions.includes(permission);
  });
}

function csvEnv(name: string, fallback: readonly string[]): readonly string[] {
  const value = process.env[name]?.trim();
  return value ? csvHeader(value) : fallback;
}

function csvHeader(value: string | null): readonly string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSha256Hex(value: string, name: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${name} must contain SHA-256 hex values.`);
  }
  return normalized;
}

function secureHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isStaticPath(pathname: string): boolean {
  return STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
