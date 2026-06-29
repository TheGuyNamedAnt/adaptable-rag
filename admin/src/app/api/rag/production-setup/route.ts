import { NextResponse } from "next/server";
import { getProductionSetupChecklist } from "@/lib/production-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getProductionSetupChecklist());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        summary: {
          stepCount: 1,
          passedCount: 0,
          warningCount: 0,
          failedCount: 1,
          pendingCount: 0
        },
        steps: [
          {
            id: "production_setup.unhandled_error",
            area: "Production setup",
            title: "Production setup checklist",
            status: "failed",
            detail:
              error instanceof Error && error.message.trim()
                ? error.message.slice(0, 1200)
                : "Production setup checklist failed.",
            evidence: [],
            env: [],
            commands: [],
            recheckPath: "/storage"
          }
        ]
      },
      { status: 500 }
    );
  }
}
