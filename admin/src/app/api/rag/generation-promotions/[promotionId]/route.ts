import { NextResponse } from "next/server";
import { getGenerationPromotion } from "@/lib/rag-admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly promotionId: string }> }
) {
  const { promotionId: rawPromotionId } = await params;
  const promotionId = decodeURIComponent(rawPromotionId).trim();
  if (!promotionId) {
    return NextResponse.json(
      {
        status: "unavailable",
        error: "promotionId is required."
      },
      { status: 400 }
    );
  }

  const result = await getGenerationPromotion(promotionId);
  return NextResponse.json(result, { status: result.status === "available" ? 200 : 503 });
}
