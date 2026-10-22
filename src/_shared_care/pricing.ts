// 照護儲值手續費與訂閱價格。唯一來源是 DB pro_care_matching.care_service_config
// （App 也讀同一份，見 care repo 的 20261007100000_topup_subscription_pricing.sql），
// 這裡不再寫死；讀不到或設定不合理時退回現行值，不讓金流因設定問題中斷。
import { careSelectOne, type AdminClient } from "./db.ts";

export type CarePricing = {
  /** 儲值金流手續費（萬分比，外加、無條件進位）。245 = 2.45% */
  topupFeeBasisPoints: number;
  topupMinTwd: number;
  topupMaxTwd: number;
  /** 訂閱價格；只影響新訂閱（綠界定期定額每期金額在建立時就固定）。 */
  subscriptionMonthlyTwd: number;
  subscriptionYearlyTwd: number;
};

/** 現行值：設定讀不到時的保底，也是 DB 欄位的預設值。 */
export const DEFAULT_CARE_PRICING: CarePricing = {
  topupFeeBasisPoints: 245,
  topupMinTwd: 100,
  topupMaxTwd: 100000,
  subscriptionMonthlyTwd: 199,
  subscriptionYearlyTwd: 1990,
};

const CONFIG_COLUMNS = [
  "topup_fee_basis_points",
  "topup_min_twd",
  "topup_max_twd",
  "subscription_monthly_twd",
  "subscription_yearly_twd",
].join(",");

function intOr(value: unknown, fallback: number, isValid: (n: number) => boolean): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(n) && isValid(n) ? n : fallback;
}

/** DB 列 → 定價；每欄不合理就單獨退回預設，下限 > 上限時兩者都退回預設。 */
export function pricingFromConfigRow(row: Record<string, unknown> | null): CarePricing {
  const d = DEFAULT_CARE_PRICING;
  const r = row ?? {};
  const positive = (n: number) => n >= 1;
  let topupMinTwd = intOr(r.topup_min_twd, d.topupMinTwd, positive);
  let topupMaxTwd = intOr(r.topup_max_twd, d.topupMaxTwd, positive);
  if (topupMinTwd > topupMaxTwd) {
    topupMinTwd = d.topupMinTwd;
    topupMaxTwd = d.topupMaxTwd;
  }
  return {
    topupFeeBasisPoints: intOr(
      r.topup_fee_basis_points,
      d.topupFeeBasisPoints,
      (n) => n >= 0 && n <= 1000,
    ),
    topupMinTwd,
    topupMaxTwd,
    subscriptionMonthlyTwd: intOr(r.subscription_monthly_twd, d.subscriptionMonthlyTwd, positive),
    subscriptionYearlyTwd: intOr(r.subscription_yearly_twd, d.subscriptionYearlyTwd, positive),
  };
}

/** 每次結帳都重讀（設定很少改、單列查詢），讓管理端改了立即生效。 */
export async function loadCarePricing(admin: AdminClient): Promise<CarePricing> {
  try {
    const row = await careSelectOne<Record<string, unknown>>(admin, "care_service_config", {
      select: CONFIG_COLUMNS,
      id: "eq.true",
    });
    return pricingFromConfigRow(row);
  } catch (error) {
    console.error("[care-pricing] 讀取 care_service_config 失敗，改用現行值", error);
    return DEFAULT_CARE_PRICING;
  }
}
