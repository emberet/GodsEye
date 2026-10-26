import { NextResponse } from "next/server";
import { feed, hosted, missingHostedSetup } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get() {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return feed("rugchecks");
  // Local: read GodsEye's database directly (loaded only here, never on Vercel).
  const { getRugChecks } = await import("@/lib/queries");
  return NextResponse.json(getRugChecks());
}

export const GET = apiRoute(get);
