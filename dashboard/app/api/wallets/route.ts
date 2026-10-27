import { NextResponse, type NextRequest } from "next/server";
import { hosted, missingHostedSetup, parseWalletQuery, walletsFeed } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get(req: NextRequest) {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  const q = parseWalletQuery(req.nextUrl.searchParams);
  if (hosted()) return walletsFeed(q);
  const { listWallets } = await import("@/lib/queries");
  return NextResponse.json(listWallets(q));
}

export const GET = apiRoute(get, "wallets");
