import { NextResponse } from "next/server";
import { getReviewQueue } from "@/lib/review-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getReviewQueue());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "degraded",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Review queue failed."
      },
      { status: 500 }
    );
  }
}
