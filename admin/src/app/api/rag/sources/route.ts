import { NextResponse } from "next/server";
import { getSourceHealth } from "@/lib/rag-admin-api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId")?.trim();
  if (!jobId) {
    return NextResponse.json(
      {
        status: "unavailable",
        error: "jobId is required for source health inspection."
      },
      { status: 400 }
    );
  }

  const sourceId = url.searchParams.get("sourceId")?.trim() || undefined;
  const result = await getSourceHealth(jobId, sourceId);
  return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
}
