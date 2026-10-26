import { NextResponse, type NextRequest } from "next/server";
import { hosted, missingHostedSetup, proofFeed } from "@/lib/data";
import { apiRoute, intParam } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get(req: NextRequest) {
  const limit = intParam(req.nextUrl.searchParams.get("limit"), 50, 1, 200);
  const offset = intParam(req.nextUrl.searchParams.get("offset"), 0, 0, 1_000_000);
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return proofFeed(limit, offset);
  const { getProof } = await import("@/lib/queries");
  return NextResponse.json(getProof(limit, offset));
}

export const GET = apiRoute(get);
