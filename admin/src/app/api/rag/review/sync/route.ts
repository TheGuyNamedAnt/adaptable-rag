import { NextResponse } from "next/server";
import {
  getAdminReviewSyncArtifactStatus,
  runAdminReviewDryRunSync
} from "@/lib/review-sync-artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getAdminReviewSyncArtifactStatus());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Admin review sync status failed."
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    return NextResponse.json(await runAdminReviewDryRunSync());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Admin review dry-run sync failed."
      },
      { status: 500 }
    );
  }
}
