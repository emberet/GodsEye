import { NextResponse } from "next/server";
import { feed, hosted, missingHostedSetup } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get() {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return feed("runners");
  const { getRunners } = await import("@/lib/queries");
  return NextResponse.json(getRunners());
}

export const GET = apiRoute(get, "runners");
