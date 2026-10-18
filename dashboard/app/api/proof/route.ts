import { NextResponse, type NextRequest } from "next/server";
import { hosted, missingHostedSetup, proofFeed } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset") ?? 0));
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return proofFeed(limit, offset);
  const { getProof } = await import("@/lib/queries");
  return NextResponse.json(getProof(limit, offset));
}
