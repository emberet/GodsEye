// The shapes live in the shared package so GodsEye can publish exactly the same data.
export type * from "@godseye/shared/dashboard-types";
export type { ProofEntryRow as ProofRow } from "@godseye/shared/dashboard-types";
export type { Tier, WalletKind } from "@godseye/shared/constants";
