import { NextResponse } from "next/server";
import { feed, hosted, missingHostedSetup } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  if (hosted()) return feed("logs");
  // Local: read GodsEye's database directly (loaded only here, never on Vercel).
  const { getLogs } = await import("@/lib/queries");
  return NextResponse.json(getLogs());
}
