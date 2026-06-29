import { NextResponse } from "next/server";
import { getSloDashboard } from "@/lib/slo-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSloDashboard());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        error:
          error instanceof Error && error.message.trim()
            ? error.message.slice(0, 1200)
            : "SLO dashboard failed."
      },
      { status: 500 }
    );
  }
}
