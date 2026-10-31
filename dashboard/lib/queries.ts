import "server-only";
import * as data from "@godseye/shared/dashboard-data";
import type { WalletQuery } from "@godseye/shared/dashboard-types";
import { db } from "./db";

// Local mode: compute every feed straight from GodsEye's database file.
export const getSummary = () => data.getSummary(db());
export const listWallets = (q: WalletQuery) => data.listWallets(db(), q);
export const getWalletDetail = (address: string) => data.getWalletDetail(db(), address);
export const getWalletGroups = () => data.getWalletGroups(db());
export const getLeaders = () => data.getLeaders(db());
export const getCopies = () => data.getCopies(db());
export const getPerformance = () => data.getPerformance(db());
export const getProof = (limit: number, offset: number) => data.getProof(db(), limit, offset);
export const getLogs = () => data.getLogs(db());
export const getRugChecks = () => data.getRugChecks(db());
export const getLiveWallets = (q: import("@godseye/shared/dashboard-types").LiveQuery) => data.getLiveWallets(db(), q);
export const getSmartMoney = () => data.getSmartMoney(db());
export const getRunners = () => data.getRunners(db());
