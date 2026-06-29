import { NextResponse } from "next/server";
import { getAdminDoctor } from "@/lib/admin-doctor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getAdminDoctor());
  } catch (error) {
    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        status: "failed",
        checks: [
          {
            id: "admin_doctor.unhandled_error",
            label: "Admin Doctor",
            status: "failed",
            area: "connector_state",
            detail:
              error instanceof Error && error.message.trim()
                ? error.message.slice(0, 1200)
                : "Admin Doctor failed."
          }
        ],
        metadata: {
          traceHistory: {
            area: "trace_history",
            configuredKind: "auto",
            effectiveKind: "json_file",
            schema: "rag_core",
            urlConfigured: false,
            requiredMigration: "deploy/postgres/004_admin_trace_history.sql",
            requiredTables: ["admin_answer_runs"]
          },
          connectorState: {
            area: "connector_state",
            configuredKind: "auto",
            effectiveKind: "json_file",
            schema: "rag_core",
            urlConfigured: false,
            requiredMigration: "deploy/postgres/005_admin_connector_state.sql",
            requiredTables: ["admin_connector_actions", "admin_connector_disabled_overrides"]
          },
          reviewWorkflow: {
            area: "review_queue",
            configuredKind: "auto",
            effectiveKind: "json_file",
            schema: "rag_core",
            urlConfigured: false,
            requiredMigration: "deploy/postgres/006_admin_review_queue.sql",
            requiredTables: ["admin_review_states"]
          }
        },
        recommendations: ["Fix the admin Doctor server error, then rerun the check."]
      },
      { status: 500 }
    );
  }
}
