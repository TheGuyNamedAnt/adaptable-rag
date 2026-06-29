import { NextResponse } from "next/server";
import { isReviewWorkflowStatus } from "@/lib/review-workflow-types";
import {
  getReviewWorkflowStorageKind,
  upsertReviewWorkflowState
} from "@/lib/review-workflow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const payload = body as {
    readonly itemId?: unknown;
    readonly status?: unknown;
    readonly owner?: unknown;
    readonly note?: unknown;
    readonly updatedBy?: unknown;
  };

  if (typeof payload.itemId !== "string" || !payload.itemId.trim()) {
    return NextResponse.json({ error: "itemId is required." }, { status: 400 });
  }

  if (!isReviewWorkflowStatus(payload.status)) {
    return NextResponse.json(
      {
        error: "status must be one of open, acknowledged, in_review, resolved, or dismissed."
      },
      { status: 400 }
    );
  }

  try {
    const state = await upsertReviewWorkflowState({
      itemId: payload.itemId,
      status: payload.status,
      ...(typeof payload.owner === "string" ? { owner: payload.owner } : {}),
      ...(typeof payload.note === "string" ? { note: payload.note } : {}),
      updatedBy: typeof payload.updatedBy === "string" ? payload.updatedBy : "admin_ui"
    });
    return NextResponse.json({
      status: "saved",
      storageKind: getReviewWorkflowStorageKind(),
      state
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Review workflow action failed."
      },
      { status: 500 }
    );
  }
}
