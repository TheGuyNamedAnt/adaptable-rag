import { NextResponse } from "next/server";
import { adminPreflightErrorBody, generationPromotionPreflight } from "@/lib/admin-api-preflight";
import {
  getGenerationPromotion,
  planGenerationPromotion,
  promoteGeneration,
  recordGenerationEval
} from "@/lib/rag-admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PromotionAction = "plan" | "record_eval" | "promote";

interface PromotionActionBody {
  readonly action?: unknown;
  readonly promotionId?: unknown;
  readonly tenantId?: unknown;
  readonly namespaceId?: unknown;
  readonly profileId?: unknown;
  readonly generationId?: unknown;
  readonly activeGenerationId?: unknown;
  readonly embeddingProvider?: unknown;
  readonly embeddingModel?: unknown;
  readonly embeddingDimensions?: unknown;
  readonly embeddingConfigHash?: unknown;
  readonly embeddingIndexConfigHash?: unknown;
  readonly chunkingPolicyId?: unknown;
  readonly chunkingPolicyVersion?: unknown;
  readonly chunkerVersion?: unknown;
  readonly requiredEvalIds?: unknown;
  readonly archivePrevious?: unknown;
  readonly dryRun?: unknown;
  readonly replace?: unknown;
  readonly requestedAt?: unknown;
  readonly evalReportUri?: unknown;
  readonly evalId?: unknown;
  readonly evalStatus?: unknown;
  readonly recordedAt?: unknown;
  readonly reportUri?: unknown;
  readonly summary?: unknown;
  readonly promotedAt?: unknown;
}

export async function POST(request: Request) {
  const body = await parseRequestBody(request);
  if (body === undefined) {
    return invalidRequest("Generation promotion action body must be JSON.");
  }

  const action = actionField(body.action);
  if (action === undefined) {
    return invalidRequest("action must be one of plan, record_eval, or promote.");
  }

  if (action === "plan") {
    const input = planInput(body);
    if ("error" in input) return invalidRequest(input.error);
    const result = await planGenerationPromotion(input);
    return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
  }

  if (action === "record_eval") {
    const input = recordEvalInput(body);
    if ("error" in input) return invalidRequest(input.error);
    const result = await recordGenerationEval(input);
    return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
  }

  const input = promoteInput(body);
  if ("error" in input) return invalidRequest(input.error);
  const inspected = await getGenerationPromotion(input.promotionId);
  const promotion = inspected.data;
  if (inspected.status !== "available" || promotion === undefined) {
    return NextResponse.json(
      adminPreflightErrorBody({
        name: "GenerationPromotionUnavailable",
        code: "generation_promotion_unavailable",
        message: inspected.error ?? "Saved generation promotion could not be inspected.",
        actionHref: "/quality-ops",
        actionLabel: "Review Promotion",
        details: {
          promotionId: input.promotionId,
          status: inspected.status
        }
      }),
      { status: 503 }
    );
  }

  const preflight = generationPromotionPreflight(promotion);
  if (preflight.status === "failed" && preflight.failure) {
    return NextResponse.json(adminPreflightErrorBody(preflight.failure), {
      status: preflight.httpStatus
    });
  }

  const result = await promoteGeneration(input);
  return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
}

async function parseRequestBody(request: Request): Promise<PromotionActionBody | undefined> {
  try {
    const value = (await request.json()) as unknown;
    return typeof value === "object" && value !== null ? (value as PromotionActionBody) : undefined;
  } catch {
    return undefined;
  }
}

function planInput(body: PromotionActionBody):
  | Parameters<typeof planGenerationPromotion>[0]
  | {
      readonly error: string;
    } {
  const promotionId = stringField(body.promotionId);
  const tenantId = stringField(body.tenantId);
  const namespaceId = stringField(body.namespaceId);
  const generationId = stringField(body.generationId);
  const embeddingProvider = stringField(body.embeddingProvider);
  const embeddingModel = stringField(body.embeddingModel);
  const embeddingDimensions = positiveIntegerField(body.embeddingDimensions);
  const embeddingConfigHash = stringField(body.embeddingConfigHash);
  const embeddingIndexConfigHash = stringField(body.embeddingIndexConfigHash);
  const chunkingPolicyId = stringField(body.chunkingPolicyId);
  const chunkingPolicyVersion = positiveIntegerField(body.chunkingPolicyVersion);
  if (
    promotionId === undefined ||
    tenantId === undefined ||
    namespaceId === undefined ||
    generationId === undefined ||
    embeddingProvider === undefined ||
    embeddingModel === undefined ||
    embeddingDimensions === undefined ||
    embeddingConfigHash === undefined ||
    embeddingIndexConfigHash === undefined ||
    chunkingPolicyId === undefined ||
    chunkingPolicyVersion === undefined
  ) {
    return {
      error:
        "plan requires promotionId, tenantId, namespaceId, generationId, embeddingProvider, embeddingModel, embeddingDimensions, embeddingConfigHash, embeddingIndexConfigHash, chunkingPolicyId, and chunkingPolicyVersion."
    };
  }

  return {
    promotionId,
    tenantId,
    namespaceId,
    generationId,
    embeddingProvider,
    embeddingModel,
    embeddingDimensions,
    embeddingConfigHash,
    embeddingIndexConfigHash,
    chunkingPolicyId,
    chunkingPolicyVersion,
    ...optionalString("profileId", body.profileId),
    ...optionalString("activeGenerationId", body.activeGenerationId),
    ...optionalString("chunkerVersion", body.chunkerVersion),
    ...optionalString("requestedAt", body.requestedAt),
    ...optionalString("evalReportUri", body.evalReportUri),
    ...optionalStringArray("requiredEvalIds", body.requiredEvalIds),
    ...optionalBoolean("archivePrevious", body.archivePrevious),
    ...optionalBoolean("dryRun", body.dryRun),
    ...optionalBoolean("replace", body.replace)
  };
}

function recordEvalInput(body: PromotionActionBody):
  | Parameters<typeof recordGenerationEval>[0]
  | {
      readonly error: string;
    } {
  const promotionId = stringField(body.promotionId);
  const evalId = stringField(body.evalId);
  const evalStatus = evalStatusField(body.evalStatus);
  if (promotionId === undefined || evalId === undefined || evalStatus === undefined) {
    return {
      error: "record_eval requires promotionId, evalId, and evalStatus passed|failed."
    };
  }

  return {
    promotionId,
    evalId,
    evalStatus,
    ...optionalString("recordedAt", body.recordedAt),
    ...optionalString("requestedAt", body.requestedAt),
    ...optionalString("reportUri", body.reportUri),
    ...optionalString("summary", body.summary)
  };
}

function promoteInput(body: PromotionActionBody):
  | Parameters<typeof promoteGeneration>[0]
  | {
      readonly error: string;
    } {
  const promotionId = stringField(body.promotionId);
  if (promotionId === undefined) {
    return { error: "promote requires promotionId." };
  }

  return {
    promotionId,
    ...optionalString("promotedAt", body.promotedAt),
    ...optionalString("requestedAt", body.requestedAt)
  };
}

function invalidRequest(message: string) {
  return NextResponse.json(
    {
      status: "rejected",
      error: {
        name: "InvalidGenerationPromotionAction",
        message
      }
    },
    { status: 400 }
  );
}

function actionField(value: unknown): PromotionAction | undefined {
  return value === "plan" || value === "record_eval" || value === "promote" ? value : undefined;
}

function evalStatusField(value: unknown): "passed" | "failed" | undefined {
  return value === "passed" || value === "failed" ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveIntegerField(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString<TName extends string>(
  name: TName,
  value: unknown
): { readonly [key in TName]?: string } {
  const parsed = stringField(value);
  return parsed === undefined ? {} : ({ [name]: parsed } as { readonly [key in TName]?: string });
}

function optionalBoolean<TName extends string>(
  name: TName,
  value: unknown
): { readonly [key in TName]?: boolean } {
  return typeof value === "boolean"
    ? ({ [name]: value } as { readonly [key in TName]?: boolean })
    : {};
}

function optionalStringArray<TName extends string>(
  name: TName,
  value: unknown
): { readonly [key in TName]?: readonly string[] } {
  const values = Array.isArray(value)
    ? value.map(stringField).filter((entry): entry is string => entry !== undefined)
    : undefined;
  return values === undefined || values.length === 0
    ? {}
    : ({ [name]: values } as unknown as { readonly [key in TName]?: readonly string[] });
}
