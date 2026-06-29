import { NextResponse } from "next/server";
import { getStorageDashboard } from "@/lib/storage-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getStorageDashboard());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "Storage dashboard failed."
      },
      { status: 500 }
    );
  }
}
