import { NextResponse } from "next/server";
import { getAdminAnswerRun } from "@/lib/answer-history-store";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const result = await getAdminAnswerRun(decodeURIComponent(runId));
    if (!result) {
      return NextResponse.json(
        {
          error: {
            name: "AnswerRunNotFound",
            message: "Answer run was not found in admin trace history."
          }
        },
        { status: 404 }
      );
    }

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

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 1000);
  }
  return "Answer run history is unavailable.";
}
