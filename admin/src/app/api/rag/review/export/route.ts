import { NextResponse } from "next/server";
import {
  buildAdminReviewWorkflowExport,
  renderAdminReviewWorkflowExportMarkdown
} from "@/lib/review-workflow-export";
import { isReviewWorkflowStatus } from "@/lib/review-workflow-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? undefined;
  const ownerParam = url.searchParams.get("owner") ?? undefined;
  const limitParam = url.searchParams.get("limit") ?? undefined;
  const offsetParam = url.searchParams.get("offset") ?? undefined;
  const format = url.searchParams.get("format") ?? "json";

  if (statusParam !== undefined && !isReviewWorkflowStatus(statusParam)) {
    return NextResponse.json(
      {
        error: "status must be one of open, acknowledged, in_review, resolved, or dismissed."
      },
      { status: 400 }
    );
  }

  if (format !== "json" && format !== "markdown") {
    return NextResponse.json({ error: "format must be json or markdown." }, { status: 400 });
  }

  try {
    const artifact = await buildAdminReviewWorkflowExport({
      ...(statusParam ? { status: statusParam } : {}),
      ...(ownerParam ? { owner: ownerParam } : {}),
      ...(limitParam ? { limit: Number(limitParam) } : {}),
      ...(offsetParam ? { offset: Number(offsetParam) } : {})
    });
    if (format === "markdown") {
      return new NextResponse(renderAdminReviewWorkflowExportMarkdown(artifact), {
        headers: { "content-type": "text/markdown; charset=utf-8" }
      });
    }
    return NextResponse.json(artifact);
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Admin review workflow export failed."
      },
      { status: 500 }
    );
  }
}
