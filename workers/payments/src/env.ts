/** The few R2 methods we use (keeps the Worker free of the Cloudflare types package). */
export interface R2Like {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}
export interface Env {
  PAYSTACK_SECRET_KEY: string;
  /** Optional Cloudflare Rate Limiting binding for the public routes (see wrangler.toml). Without it those routes are not rate limited here. */
  PUBLIC_RL?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** Set to 'true' only on a staging Worker. Otherwise a Paystack TEST key (sk_test_…) switches money routes off so test cards can never unlock plans or deposits. */
  ALLOW_TEST_PAYMENTS?: string;
  FIREBASE_SERVICE_ACCOUNT: string;
  FIREBASE_PROJECT_ID: string;
  APP_URL: string;
  ALLOWED_ORIGINS: string;
  NGN_PER_USD?: string;
  /** Optional: alert e-mails and webhook-less notifications go out through Resend when this is set. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Optional R2 bucket for encrypted workspace backups (see wrangler.toml). Without it, backups stay off. */
  BACKUPS?: R2Like;
  /** Secret: 32 random bytes, base64. Encrypts every backup. Losing it makes old backups unreadable, so keep a copy somewhere safe. */
  BACKUP_KEY?: string;
  /** Set only by the test harness: talk to the Firestore emulator instead of production. Never set in wrangler.toml. */
  FIRESTORE_EMULATOR_HOST?: string;
  /** Flat platform fee, in kobo, kept by ZexCore on each booking deposit. Defaults to 0. */
  DEPOSIT_FEE_MINOR?: string;
}
export interface Deps { fetch: typeof fetch; now: () => Date }
export const realDeps = (): Deps => ({ fetch: (...a) => fetch(...a), now: () => new Date() });

export interface Ctx { req: Request; env: Env; d: Deps; url: URL; headers: Record<string, string> }
