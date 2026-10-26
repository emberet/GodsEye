import { NextResponse } from "next/server";
import { feed, hosted, missingHostedSetup } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get() {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return feed("performance");
  // Local: read GodsEye's database directly (loaded only here, never on Vercel).
  const { getPerformance } = await import("@/lib/queries");
  return NextResponse.json(getPerformance());
}

export const GET = apiRoute(get);
