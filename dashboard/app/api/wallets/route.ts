import { NextResponse, type NextRequest } from "next/server";
import { hosted, missingHostedSetup, parseWalletQuery, walletsFeed } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  const q = parseWalletQuery(req.nextUrl.searchParams);
  if (hosted()) return walletsFeed(q);
  const { listWallets } = await import("@/lib/queries");
  return NextResponse.json(listWallets(q));
}
