import { NextResponse } from "next/server";
import { getIndexGenerations } from "@/lib/rag-admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await getIndexGenerations({
    tenantId: optionalParam(url, "tenantId"),
    namespaceId: optionalParam(url, "namespaceId"),
    statuses: generationStatuses(url),
    limit: positiveIntegerParam(url, "limit")
  });
  return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
}

function optionalParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function generationStatuses(url: URL): readonly string[] | undefined {
  const statuses = url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return statuses.length === 0 ? undefined : statuses;
}

function positiveIntegerParam(url: URL, key: string): number | undefined {
  const value = Number(url.searchParams.get(key));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
