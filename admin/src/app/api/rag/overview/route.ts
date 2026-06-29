import { NextResponse } from "next/server";
import { getOverview } from "@/lib/rag-admin-api";

export async function GET() {
  return NextResponse.json(await getOverview());
}
