import { NextResponse } from "next/server";
import { getIngestionJobDetail } from "@/lib/rag-admin-api";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const url = new URL(request.url);
  const { jobId } = await params;
  const result = await getIngestionJobDetail(jobId, {
    sourceId: optionalParam(url, "sourceId"),
    documentStatus: url.searchParams.getAll("documentStatus").filter(Boolean),
    documentLimit: positiveIntegerParam(url, "documentLimit"),
    documentOffset: nonNegativeIntegerParam(url, "documentOffset"),
    checkpointLimit: positiveIntegerParam(url, "checkpointLimit"),
    checkpointOffset: nonNegativeIntegerParam(url, "checkpointOffset")
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

function nonNegativeIntegerParam(url: URL, key: string): number | undefined {
  const value = Number(url.searchParams.get(key));
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
