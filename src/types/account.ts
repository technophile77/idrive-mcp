/**
 * Feature flags returned by `GET /idrive/home/products/account/exists`,
 * gating which product sections (Remote PC, E2 object storage, 360 backup)
 * show in iDrive's left nav. Typed loosely because the exact key set isn't
 * guaranteed stable across accounts — treat unknown keys as possible.
 *
 * @example
 * ```ts
 * const flags: AccountFeatureFlags = { showRPCLHS: true, showE2LHS: true, show360LHS: true };
 * ```
 */
export type AccountFeatureFlags = Record<string, boolean>;

/**
 * Pricing/upsell info for iDrive's cloud-to-cloud (c2c) product tier, as
 * returned by `GET /idrive/home/c2c/custom/plan/user`. This is **not** a
 * list of the user's actual connected cloud accounts (Google Drive,
 * iCloud, etc.) or their backed-up data — it's what the console shows to
 * upsell/renew the c2c plan. See `docs/api-map.md`, "Still needed from
 * you" item 6, for the still-undiscovered endpoint that would expose real
 * connected-account data.
 *
 * @example
 * ```ts
 * const plan: CloudBackupPlan = {
 *   customPlanExists: false,
 *   nooffertarmonthlyprice: "2.00",
 *   offerPercentage: 100,
 *   noofferyearlyprice: "20.00",
 *   plantype: "Y",
 *   plan: "20.00/Seat/Year",
 *   yearlyprice: "20.00",
 *   monthlyprice: "2.00",
 *   promocodeExists: false,
 * };
 * ```
 */
export type CloudBackupPlan = {
  customPlanExists: boolean;
  nooffertarmonthlyprice: string;
  offerPercentage: number;
  noofferyearlyprice: string;
  plantype: string;
  plan: string;
  yearlyprice: string;
  monthlyprice: string;
  promocodeExists: boolean;
};

/**
 * The account's storage quota, scraped from two inline `<script>` variables
 * on `GET /idrive/home/account.html` (`syncUsedQuota`/`syncTotalQuota`) —
 * there is no dedicated JSON usage endpoint (see `docs/api-map.md`'s
 * "Account/storage usage" section). Values are kept as raw, free-form
 * strings with their unit suffix (e.g. `"0.00 KB"`, `"5000.00 GB"`) rather
 * than parsed into a number/unit pair, since their exact format isn't
 * confirmed stable across accounts. Reflects the page's own "Sync" quota
 * naming specifically — whether it also represents total usage across
 * device backups (not just the Sync area) is unconfirmed.
 *
 * @example
 * ```ts
 * const usage: AccountUsage = { syncUsedQuota: "0.00 KB", syncTotalQuota: "5000.00 GB" };
 * ```
 * @see extractAccountUsage
 * @see get_account_usage
 */
export type AccountUsage = {
  syncUsedQuota: string;
  syncTotalQuota: string;
};
