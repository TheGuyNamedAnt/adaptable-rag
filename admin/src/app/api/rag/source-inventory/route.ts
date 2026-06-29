import { NextResponse } from "next/server";
import { getSourceInventory } from "@/lib/source-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSourceInventory());
}
