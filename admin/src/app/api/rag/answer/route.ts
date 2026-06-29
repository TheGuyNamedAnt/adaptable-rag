import { NextResponse } from "next/server";
import {
  adminPreflightErrorBody,
  answerPreflightFromShell,
  answerRequestPreflight
} from "@/lib/admin-api-preflight";
import { saveAdminAnswerRun } from "@/lib/answer-history-store";
import { getShellOverview, postAnswer } from "@/lib/rag-admin-api";
import type { AdminAnswerRequest } from "@/lib/rag-answer-types";

export async function POST(request: Request) {
  let body: AdminAnswerRequest;
  try {
    body = (await request.json()) as AdminAnswerRequest;
  } catch {
    return NextResponse.json(
      { error: { name: "InvalidJsonBody", message: "Request body must be valid JSON." } },
      { status: 400 }
    );
  }

  const requestFailure = answerRequestPreflight(body);
  if (requestFailure) {
    return NextResponse.json(adminPreflightErrorBody(requestFailure), { status: 400 });
  }

  const preflight = answerPreflightFromShell(await getShellOverview());
  if (preflight.status === "failed" && preflight.failure) {
    return NextResponse.json(adminPreflightErrorBody(preflight.failure), {
      status: preflight.httpStatus
    });
  }

  const result = await postAnswer(body);
  const data = result.data;
  if (result.status === "available" && data) {
    try {
      await saveAdminAnswerRun({ request: body, response: data });
    } catch (error) {
      console.warn("Failed to save admin answer trace history.", error);
    }
    return NextResponse.json(data);
  }

  return NextResponse.json(
    {
      error: {
        name: "RagAnswerUnavailable",
        message: result.error ?? "RAG answer endpoint is unavailable."
      }
    },
    { status: 502 }
  );
}
