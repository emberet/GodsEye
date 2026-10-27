import { NextResponse } from "next/server";
import { hosted, missingHostedSetup, walletFeed } from "@/lib/data";
import { apiRoute } from "@/lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function get(_req: Request, { params }: { params: { address: string } }) {
  const notSetUp = missingHostedSetup();
  if (notSetUp) return notSetUp;
  const address = params.address;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return NextResponse.json({ error: "Not a Solana address." }, { status: 400 });
  if (hosted()) return walletFeed(address);
  const { getWalletDetail } = await import("@/lib/queries");
  const d = getWalletDetail(address);
  return d ? NextResponse.json(d) : NextResponse.json({ error: "GodsEye hasn't analyzed this wallet yet." }, { status: 404 });
}

export const GET = apiRoute(get, "wallet");
