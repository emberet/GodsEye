import { NextResponse, type NextRequest } from "next/server";
import { hosted, liveFeed, missingHostedSetup, parseLiveQuery } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get(req: NextRequest) {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  const q = parseLiveQuery(req.nextUrl.searchParams);
  if (hosted()) return liveFeed(q);
  const { getLiveWallets } = await import("@/lib/queries");
  return NextResponse.json(getLiveWallets(q));
}

export const GET = apiRoute(get);
