import { NextResponse } from "next/server";
import { getConnectorRegistry } from "@/lib/connector-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getConnectorRegistry());
}
