import { NextResponse } from "next/server";
import { getIngestionJobs } from "@/lib/rag-admin-api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await getIngestionJobs({
    tenantId: optionalParam(url, "tenantId"),
    namespaceId: optionalParam(url, "namespaceId"),
    status: optionalParam(url, "status"),
    limit: positiveIntegerParam(url, "limit")
  });
  return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
}

function optionalParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function positiveIntegerParam(url: URL, key: string): number | undefined {
  const value = Number(url.searchParams.get(key));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
