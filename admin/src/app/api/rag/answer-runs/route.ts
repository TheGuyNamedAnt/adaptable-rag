import { NextResponse } from "next/server";
import { listAdminAnswerRuns } from "@/lib/answer-history-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const result = await listAdminAnswerRuns({
      limit: positiveIntegerParam(url, "limit"),
      offset: nonNegativeIntegerParam(url, "offset"),
      filters: {
        status: optionalParam(url, "status"),
        tenantId: optionalParam(url, "tenantId"),
        namespaceId: optionalParam(url, "namespaceId"),
        runId: optionalParam(url, "runId"),
        traceId: optionalParam(url, "traceId"),
        rejectionCode: optionalParam(url, "rejectionCode"),
        from: optionalParam(url, "from"),
        to: optionalParam(url, "to")
      }
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          name: "AnswerRunHistoryUnavailable",
          message: safeErrorMessage(error)
        }
      },
      { status: 503 }
    );
  }
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

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 1000);
  }
  return "Answer run history is unavailable.";
}
