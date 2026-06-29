import { NextResponse } from "next/server";
import { listReviewWorkflowHistory } from "@/lib/review-workflow-store";
import { isReviewWorkflowStatus } from "@/lib/review-workflow-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  const ownerParam = url.searchParams.get("owner") ?? undefined;
  const limitParam = url.searchParams.get("limit") ?? undefined;
  const offsetParam = url.searchParams.get("offset") ?? undefined;

  if (statusParam !== undefined && !isReviewWorkflowStatus(statusParam)) {
    return NextResponse.json(
      {
        error: "status must be one of open, acknowledged, in_review, resolved, or dismissed."
      },
      { status: 400 }
    );
  }

  try {
    return NextResponse.json(
      await listReviewWorkflowHistory({
        ...(statusParam ? { status: statusParam } : {}),
        ...(ownerParam ? { owner: ownerParam } : {}),
        ...(limitParam ? { limit: Number(limitParam) } : {}),
        ...(offsetParam ? { offset: Number(offsetParam) } : {})
      })
    );
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Review workflow history failed."
      },
      { status: 500 }
    );
  }
}
