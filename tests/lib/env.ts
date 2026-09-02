const DEFAULT_ENV: Record<string, string> = {
  FUNCTIONS_PUBLIC_URL: "https://functions.test/functions/v1",
  SUPABASE_PUBLIC_URL: "https://supabase.test",
  SITE_URL: "https://frontend.test",
  ENVIRONMENT: "production",

  ECPAY_MERCHANT_ID: "2000132",
  ECPAY_HASH_KEY: "5294y06JbISpM5x9",
  ECPAY_HASH_IV: "v77hoKGq4kWxNNIS",
  ECPAY_CHECKOUT_URL: "https://ecpay.test/payment/checkout",
  ECPAY_CREDIT_ACTION_URL: "https://ecpay.test/payment/credit-action",
  ECPAY_CREDIT_PERIOD_ACTION_URL: "https://ecpay.test/payment/period-action",
  ECPAY_PLATFORM_ID: "",

  ECPAY_LOGISTICS_C2C_MERCHANT_ID: "2000132",
  ECPAY_LOGISTICS_C2C_HASH_KEY: "XBERn1YOvpM9nfZc",
  ECPAY_LOGISTICS_C2C_HASH_IV: "h1ONHk4P4yqbl5LK",
  ECPAY_LOGISTICS_MAP_URL: "https://ecpay.test/logistics/map",
  ECPAY_LOGISTICS_CREATE_URL: "https://ecpay.test/logistics/create",

  ECPAY_INVOICE_MERCHANT_ID: "2000132",
  ECPAY_INVOICE_HASH_KEY: "1234567890abcdef",
  ECPAY_INVOICE_HASH_IV: "abcdef1234567890",
  ECPAY_INVOICE_ISSUE_URL: "https://ecpay.test/invoice/issue",
  ECPAY_INVOICE_INVALID_URL: "https://ecpay.test/invoice/invalid",
  ECPAY_INVOICE_PRINT_URL: "https://ecpay.test/invoice/print",
  ECPAY_INVOICE_PLATFORM_ID: "",

  TEST_USER_PHONE: "0912345678",
  TEST_USER_PASSWORD: "123456",
  TEST_BLOCK_EXTERNAL_FETCH: "true",
  TEST_CLEANUP: "true",

  VENDOR_OWNERSHIP_TABLE: "vendors",
  VENDOR_OWNERSHIP_ID_COLUMN: "id",
  VENDOR_OWNERSHIP_USER_COLUMN: "user_id",
};

export function setDefaultTestEnv(): void {
  if (process.env.SUPABASE_URL && !process.env.SUPABASE_PUBLIC_URL) {
    process.env.SUPABASE_PUBLIC_URL = process.env.SUPABASE_URL;
  }

  for (const [key, value] of Object.entries(DEFAULT_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function requireTestEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`Missing required test environment variable: ${name}`);
  }
  return value;
}

export function optionalTestEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function requireSupabaseEnv(): {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
} {
  const supabaseUrl = requireTestEnv("SUPABASE_URL").replace(/\/+$/, "");
  const supabaseAnonKey = requireTestEnv("SUPABASE_ANON_KEY");
  const supabaseServiceRoleKey = requireTestEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseAnonKey === supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be a real service role key, not the anon key");
  }
  return { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey };
}

export function getTestUserCredentials(): { phone: string; password: string } {
  return {
    phone: requireTestEnv("TEST_USER_PHONE"),
    password: requireTestEnv("TEST_USER_PASSWORD"),
  };
}

export function cleanupEnabled(): boolean {
  return (process.env.TEST_CLEANUP ?? "true").toLowerCase() !== "false";
}
