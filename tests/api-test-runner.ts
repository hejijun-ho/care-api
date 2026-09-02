import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertIncludes,
  assertString,
  expectJson,
  expectStatus,
  responseText,
} from "./lib/assertions.ts";
import {
  cleanupEnabled,
  getTestUserCredentials,
  requireSupabaseEnv,
  setDefaultTestEnv,
} from "./lib/env.ts";
import { EcpayFetchMock } from "./lib/ecpay-mock.ts";
import { callForm, callJson, jsonRequest, type HandlerMap } from "./lib/function-client.ts";
import { TestFixtures } from "./lib/fixtures.ts";
import { CleanupTracker, SupabaseTestClient, type AuthSession } from "./lib/supabase.ts";
import { generateCheckMacValue as signPaymentCheckMac } from "../src/_shared/ecpay_payment.ts";
import { generateCheckMacValue as signLogisticsCheckMac } from "../src/_shared/ecpay_logistics.ts";
import { decryptInvoiceData } from "../src/_shared/ecpay_invoice.ts";
import { resolveInvoiceCustomer } from "../src/_shared_haiglobals/vendor_subscription_invoices.ts";

setDefaultTestEnv();

type TestContext = {
  db: SupabaseTestClient;
  cleanup: CleanupTracker;
  auth: AuthSession;
  handlers: HandlerMap;
  fixtures: TestFixtures;
  ecpay: EcpayFetchMock;
  baseVendor: { vendorId: string; email: string };
  baseProduct: { productId: string; vendorId: string };
};

type ApiTest = {
  name: string;
  tags: string[];
  fn: (ctx: TestContext) => Promise<void>;
  needsSupabase: boolean;
};

const tests: ApiTest[] = [];

function test(
  name: string,
  tags: string[],
  fn: (ctx: TestContext) => Promise<void>,
  options: { needsSupabase?: boolean } = {},
): void {
  tests.push({ name, tags, fn, needsSupabase: options.needsSupabase ?? true });
}

async function loadHandlers(): Promise<HandlerMap> {
  return {
    "delete-account": (await import("../src/functions/delete-account.ts")).default,
    hello: (await import("../src/functions/hello.ts")).default,
    "haiglobals-checkout-quote": (await import("../src/functions/haiglobals-checkout-quote.ts"))
      .default,
    "haiglobals-ecpay-checkout": (await import("../src/functions/haiglobals-ecpay-checkout.ts"))
      .default,
    "haiglobals-ecpay-invoice-print": (
      await import("../src/functions/haiglobals-ecpay-invoice-print.ts")
    ).default,
    "haiglobals-ecpay-create-shipment": (
      await import("../src/functions/haiglobals-ecpay-create-shipment.ts")
    ).default,
    "haiglobals-ecpay-logistics-notify": (
      await import("../src/functions/haiglobals-ecpay-logistics-notify.ts")
    ).default,
    "haiglobals-ecpay-logistics-reply": (
      await import("../src/functions/haiglobals-ecpay-logistics-reply.ts")
    ).default,
    "haiglobals-ecpay-logistics-selection": (
      await import("../src/functions/haiglobals-ecpay-logistics-selection.ts")
    ).default,
    "haiglobals-ecpay-order-invoice": (
      await import("../src/functions/haiglobals-ecpay-order-invoice.ts")
    ).default,
    "haiglobals-ecpay-return": (await import("../src/functions/haiglobals-ecpay-return.ts"))
      .default,
    "haiglobals-ecpay-shipment-label": (
      await import("../src/functions/haiglobals-ecpay-shipment-label.ts")
    ).default,
    "haiglobals-ecpay-vendor-subscription-checkout": (
      await import("../src/functions/haiglobals-ecpay-vendor-subscription-checkout.ts")
    ).default,
    "haiglobals-ecpay-vendor-subscription-invoice": (
      await import("../src/functions/haiglobals-ecpay-vendor-subscription-invoice.ts")
    ).default,
    "haiglobals-ecpay-vendor-subscription-return": (
      await import("../src/functions/haiglobals-ecpay-vendor-subscription-return.ts")
    ).default,
    "haiglobals-manual-create-shipment": (
      await import("../src/functions/haiglobals-manual-create-shipment.ts")
    ).default,
    "haiglobals-manual-update-shipment": (
      await import("../src/functions/haiglobals-manual-update-shipment.ts")
    ).default,
    "haiglobals-order-actions": (await import("../src/functions/haiglobals-order-actions.ts"))
      .default,
    "haiglobals-order-cancel": (await import("../src/functions/haiglobals-order-cancel.ts"))
      .default,
    "haiglobals-vendor-subscription-cancel": (
      await import("../src/functions/haiglobals-vendor-subscription-cancel.ts")
    ).default,
  };
}

async function paymentSignedPayload(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const withMerchant = {
    MerchantID: process.env.ECPAY_MERCHANT_ID,
    ...payload,
  };
  return {
    ...withMerchant,
    CheckMacValue: await signPaymentCheckMac(
      withMerchant,
      process.env.ECPAY_HASH_KEY ?? "",
      process.env.ECPAY_HASH_IV ?? "",
    ),
  };
}

async function logisticsSignedPayload(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const withMerchant = {
    MerchantID: process.env.ECPAY_LOGISTICS_C2C_MERCHANT_ID,
    ...payload,
  };
  return {
    ...withMerchant,
    CheckMacValue: await signLogisticsCheckMac(
      withMerchant,
      process.env.ECPAY_LOGISTICS_C2C_HASH_KEY ?? "",
      process.env.ECPAY_LOGISTICS_C2C_HASH_IV ?? "",
    ),
  };
}

async function createNoCodShippingMethod(
  ctx: TestContext,
): Promise<{ shippingMethodId: string; logisticsSubType: string }> {
  const shippingMethodId = randomUUID();
  const suffix = shippingMethodId.replaceAll("-", "").slice(0, 12).toUpperCase();
  const logisticsSubType = `QA_NOCOD_${suffix}`;
  await ctx.db.insertOne<Record<string, unknown>>(
    "platform_shipping_methods",
    {
      id: shippingMethodId,
      code: `qa_nocod_${suffix.toLowerCase()}`,
      name: "QA No COD Home",
      provider: "ecpay",
      logistics_type: "HOME",
      logistics_sub_type: logisticsSubType,
      shipping_fee: 0,
      is_collection_supported: false,
      enabled: true,
      sort_order: 999,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { adaptive: false },
  );
  ctx.fixtures.registerPlatformShippingMethodCleanup(shippingMethodId);

  await ctx.db.insertOne(
    "vendor_shipping_methods",
    {
      vendor_id: ctx.baseVendor.vendorId,
      shipping_method_id: shippingMethodId,
      created_at: new Date().toISOString(),
    },
    { adaptive: false },
  );
  ctx.fixtures.registerVendorShippingMethodCleanup(ctx.baseVendor.vendorId, shippingMethodId);

  return { shippingMethodId, logisticsSubType };
}

function ecpayPaymentSuccessPayload(
  merchantTradeNo: string,
  amount: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    MerchantTradeNo: merchantTradeNo,
    RtnCode: "1",
    RtnMsg: "交易成功",
    TradeNo: `QA${Date.now().toString().slice(-10)}`,
    TradeAmt: String(amount),
    PaymentDate: "2026/01/01 12:00:00",
    PaymentType: "Credit_CreditCard",
    PaymentTypeChargeFee: "0",
    TradeDate: "2026/01/01 11:59:00",
    SimulatePaid: "0",
    ...overrides,
  };
}

// ECPay reports callback timestamps in Taipei wall-clock time. The shared
// success payload above pins an old PaymentDate, which is fine for tests that
// only assert payment records, but entitlement periods are derived from it, so
// tests about a live period must pay "now".
function ecpayTaipeiDateTime(date: Date): string {
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString();
  return `${taipei.slice(0, 10).replaceAll("-", "/")} ${taipei.slice(11, 19)}`;
}

async function payVendorSubscriptionNow(
  ctx: TestContext,
  checkout: { merchantTradeNo: string; amount: number },
): Promise<void> {
  const paidAt = new Date(Date.now() - 60_000);
  await expectStatus(
    await postVendorSubscriptionCallback(ctx, checkout, {
      PaymentDate: ecpayTaipeiDateTime(paidAt),
      TradeDate: ecpayTaipeiDateTime(new Date(paidAt.getTime() - 60_000)),
    }),
    200,
  );
}

async function markOrderPaid(ctx: TestContext, orderId: string): Promise<void> {
  await ctx.fixtures.patchOrder(orderId, {
    payment_status: "paid",
    payment_provider: "ecpay",
    payment_method: "credit_card",
    provider_transaction_id: "QA-TRADE-" + Date.now().toString().slice(-8),
    paid_at: new Date().toISOString(),
  });
}

async function latestVendorSubscriptionOrder(
  db: SupabaseTestClient,
  subscriptionOrderId: string,
): Promise<Record<string, unknown>> {
  const row = await db.selectOne<Record<string, unknown>>("vendor_subscription_orders", {
    select: "*",
    id: `eq.${subscriptionOrderId}`,
  });
  if (!row) throw new Error(`Vendor subscription order not found: ${subscriptionOrderId}`);
  return row;
}

async function getSubscription(
  db: SupabaseTestClient,
  subscriptionId: string,
): Promise<Record<string, unknown>> {
  const row = await db.selectOne<Record<string, unknown>>("vendor_subscriptions", {
    select: "*",
    id: `eq.${subscriptionId}`,
  });
  if (!row) throw new Error(`Vendor subscription not found: ${subscriptionId}`);
  return row;
}

async function postVendorSubscriptionCallback(
  ctx: TestContext,
  checkout: { merchantTradeNo: string; amount: number },
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  const payload = await paymentSignedPayload(
    ecpayPaymentSuccessPayload(checkout.merchantTradeNo, checkout.amount, {
      TotalSuccessTimes: "1",
      ...overrides,
    }),
  );
  return await callForm(ctx.handlers, "haiglobals-ecpay-vendor-subscription-return", payload);
}

async function assertColumnSelectable(
  db: SupabaseTestClient,
  table: string,
  column: string,
  filters: Record<string, string | number | boolean> = {},
): Promise<void> {
  await db.selectRows<Record<string, unknown>>(table, { select: column, ...filters, limit: 1 });
}

async function assertColumnRejected(
  db: SupabaseTestClient,
  table: string,
  column: string,
): Promise<void> {
  try {
    await db.selectRows<Record<string, unknown>>(table, { select: column, limit: 1 });
  } catch (error) {
    assertIncludes(error instanceof Error ? error.message : String(error), column);
    return;
  }
  throw new Error(
    `${table}.${column} unexpectedly exists; tests must use the current schema primary key instead.`,
  );
}

async function vendorSubscriptionInvoicesForOrder(
  db: SupabaseTestClient,
  subscriptionOrderId: string,
): Promise<Array<Record<string, unknown>>> {
  return await db.selectRows<Record<string, unknown>>("vendor_subscription_invoices", {
    select: "*",
    subscription_order_id: `eq.${subscriptionOrderId}`,
    order: "created_at.desc",
  });
}

function parseArgs(argv: string[]): { list: boolean; match: string[]; tags: string[] } {
  const result = { list: false, match: [] as string[], tags: [] as string[] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") result.list = true;
    else if (arg === "--match") result.match.push(argv[++i] ?? "");
    else if (arg.startsWith("--match=")) result.match.push(arg.slice("--match=".length));
    else if (arg === "--tag") result.tags.push(argv[++i] ?? "");
    else if (arg.startsWith("--tag=")) result.tags.push(arg.slice("--tag=".length));
    else throw new Error(`Unknown test runner argument: ${arg}`);
  }
  return result;
}

function selectedTests(args: ReturnType<typeof parseArgs>): ApiTest[] {
  return tests.filter((item) => {
    if (args.match.length > 0 && !args.match.some((match) => item.name.includes(match)))
      return false;
    if (args.tags.length > 0 && !args.tags.some((tag) => item.tags.includes(tag))) return false;
    return true;
  });
}

test(
  "hello returns environment snapshot",
  ["hello"],
  async (ctx) => {
    const response = await callJson(ctx.handlers, "hello", { ping: true });
    await expectStatus(response, 200, "hello POST");
    const json = await expectJson<Record<string, unknown>>(response);
    assert.equal(json.ok, true);
    assert.equal(json.message, "hello from src/functions/hello.ts");
    assert.ok(Array.isArray(json.env));
  },
  { needsSupabase: false },
);

// -----------------------------------------------------------------------------
// Generic API contract checks for every registered handler.
// -----------------------------------------------------------------------------

test(
  "all registered API handlers answer CORS OPTIONS preflight",
  ["all-apis", "cors"],
  async (ctx) => {
    for (const [functionName, handler] of Object.entries(ctx.handlers)) {
      const response = await handler(jsonRequest(functionName, undefined, { method: "OPTIONS" }));
      await expectStatus(response, 200, `${functionName} OPTIONS`);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "*",
        `${functionName} CORS origin`,
      );
      assertIncludes(
        response.headers.get("access-control-allow-methods") ?? "",
        "OPTIONS",
        `${functionName} CORS methods`,
      );
      assertIncludes(
        response.headers.get("access-control-allow-methods") ?? "",
        "GET",
        `${functionName} CORS methods`,
      );
    }
  },
  { needsSupabase: false },
);

test(
  "all non-public API handlers reject unsupported GET requests",
  ["all-apis", "method"],
  async (ctx) => {
    for (const [functionName, handler] of Object.entries(ctx.handlers)) {
      const response = await handler(jsonRequest(functionName, undefined, { method: "GET" }));
      await expectStatus(response, 405, `${functionName} GET`);
    }
  },
  { needsSupabase: false },
);

test(
  "database schema contract uses current primary keys and rejects legacy/removed subscription columns",
  ["schema", "supabase"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan();

    await assertColumnSelectable(ctx.db, "users", "id", { id: `eq.${ctx.auth.userId}` });
    await assertColumnSelectable(ctx.db, "vendors", "id", { id: `eq.${ctx.baseVendor.vendorId}` });
    await assertColumnSelectable(ctx.db, "products", "id", {
      id: `eq.${ctx.baseProduct.productId}`,
    });
    await assertColumnSelectable(ctx.db, "vendor_subscription_plans", "code", {
      code: `eq.${plan.planCode}`,
    });
    await assertColumnSelectable(ctx.db, "vendor_subscription_features", "code", {
      code: `eq.${plan.featureCode}`,
    });

    await assertColumnRejected(ctx.db, "users", "user_id");
    await assertColumnRejected(ctx.db, "vendors", "vendor_id");
    await assertColumnRejected(ctx.db, "products", "product_id");
    await assertColumnRejected(ctx.db, "vendor_subscription_plans", "plan_id");
    await assertColumnRejected(ctx.db, "vendor_subscription_features", "feature_id");
    await assertColumnRejected(ctx.db, "vendor_subscription_plans", "entitlement_type");
    await assertColumnRejected(ctx.db, "vendor_subscription_orders", "purchase_mode");
    await assertColumnRejected(ctx.db, "vendor_subscriptions", "auto_renew");
  },
);

// -----------------------------------------------------------------------------
// Logistics selection / reply callbacks. These do not touch Supabase.
// -----------------------------------------------------------------------------

test(
  "haiglobals-ecpay-logistics-selection builds CVS map form fields",
  ["logistics", "selection"],
  async (ctx) => {
    const response = await callJson(ctx.handlers, "haiglobals-ecpay-logistics-selection", {
      logisticsSubType: "FAMIC2C",
      isCollection: true,
      clientBackUrl: "https://frontend.test/#/checkout?step=shipping",
      language: "zh-CN",
    });
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.provider, "ecpay");
    assert.equal(json.action, process.env.ECPAY_LOGISTICS_MAP_URL);
    const fields = json.fields as Record<string, string>;
    assert.equal(fields.LogisticsType, "CVS");
    assert.equal(fields.LogisticsSubType, "FAMIC2C");
    assert.equal(fields.IsCollection, "Y");
    assert.equal(fields.Language, "CHI");
    assert.ok(fields.ServerReplyURL.endsWith("/haiglobals-ecpay-logistics-reply"));
    assert.ok(fields.CheckMacValue);
  },
);

test(
  "haiglobals-ecpay-logistics-selection rejects unsupported logisticsSubType",
  ["logistics", "selection", "validation"],
  async (ctx) => {
    const response = await callJson(ctx.handlers, "haiglobals-ecpay-logistics-selection", {
      logisticsSubType: "HOME",
    });
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Unsupported CVS logisticsSubType");
  },
);

test(
  "haiglobals-ecpay-logistics-reply accepts signed store selection callback",
  ["logistics", "reply"],
  async (ctx) => {
    const payload = await logisticsSignedPayload({
      MerchantTradeNo: "OSLQA0000000001",
      LogisticsSubType: "UNIMARTC2C",
      CVSStoreID: "991182",
      CVSStoreName: "測試門市",
      CVSAddress: "台北市測試路 1 號",
      ExtraData: new URLSearchParams({
        clientBackUrl: "https://frontend.test/#/checkout",
      }).toString(),
    });
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-reply", payload);
    await expectStatus(response, 200);
    const html = await responseText(response);
    assertIncludes(html, "門市已選擇");
    assertIncludes(html, "cvsStoreId=991182");
  },
);

test(
  "haiglobals-ecpay-logistics-reply rejects invalid CheckMacValue",
  ["logistics", "reply", "security"],
  async (ctx) => {
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-reply", {
      MerchantTradeNo: "OSLQA0000000002",
      LogisticsSubType: "UNIMARTC2C",
      CVSStoreID: "991182",
      CheckMacValue: "BAD",
    });
    await expectStatus(response, 400);
    assertIncludes(await responseText(response), "CheckMacValue Error");
  },
);

// -----------------------------------------------------------------------------
// Buyer checkout and payment return.
// -----------------------------------------------------------------------------

test(
  "haiglobals-ecpay-checkout rejects missing bearer token",
  ["checkout", "auth"],
  async (ctx) => {
    const response = await callJson(ctx.handlers, "haiglobals-ecpay-checkout", {});
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Missing bearer token");
  },
);

test(
  "haiglobals-checkout-quote converts foreign currency items into TWD",
  ["checkout", "quote", "supabase"],
  async (ctx) => {
    await ctx.fixtures.createExchangeRate({ toCurrency: "USD", rate: 0.03125 });
    const usdProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA USD Product",
      base_price: 10,
      currency: "USD",
    });

    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-checkout-quote",
      {
        items: [{ productId: usdProduct.productId, quantity: 1 }],
        shippingSelections: [
          {
            vendorId: ctx.baseVendor.vendorId,
            shippingMethodId: assertString(cvsMethod?.id, "cvs platform shipping method id"),
          },
        ],
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);

    assert.equal(json.ok, true);
    assert.equal(json.currency, "TWD");
    assert.equal(Number(json.itemsSubtotal), 320);
    assert.equal("items" in json, false);

    const vendors = json.vendors as Array<Record<string, unknown>>;
    assert.equal(vendors.length, 1);
    assert.equal(vendors[0]?.vendorId, ctx.baseVendor.vendorId);
    assert.equal(vendors[0]?.shippingMethodId, cvsMethod?.id);
    assert.equal(Number(vendors[0]?.itemsSubtotal), 320);

    const items = vendors[0]?.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.productId, usdProduct.productId);
    assert.equal(items[0]?.skuId, null);
    assert.equal(Number(items[0]?.unitPrice), 320);
    assert.equal(Number(items[0]?.lineTotal), 320);
  },
);

test(
  "haiglobals-checkout-quote uses vendor shipping fee override before platform default",
  ["checkout", "quote", "supabase"],
  async (ctx) => {
    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const methodId = assertString(cvsMethod?.id, "cvs platform shipping method id");

    await ctx.db.patchRows(
      "platform_shipping_methods",
      {
        id: `eq.${methodId}`,
      },
      {
        shipping_fee: 80,
      },
    );
    await ctx.db.patchRows(
      "vendor_shipping_methods",
      {
        vendor_id: `eq.${ctx.baseVendor.vendorId}`,
        shipping_method_id: `eq.${methodId}`,
      },
      {
        shipping_fee_override: 150,
      },
    );

    const product = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA Override Shipping Product",
      base_price: 10,
      currency: "TWD",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-checkout-quote",
      {
        items: [{ productId: product.productId, quantity: 1 }],
        shippingSelections: [
          {
            vendorId: ctx.baseVendor.vendorId,
            shippingMethodId: methodId,
          },
        ],
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);

    const vendors = json.vendors as Array<Record<string, unknown>>;
    assert.equal(vendors.length, 1);
    assert.equal(Number(vendors[0]?.shippingFee), 150);
    assert.equal(Number(vendors[0]?.totalAmount), 160);
  },
);

test(
  "checkout quote and order use root vendor shipping methods for branch vendor",
  ["checkout", "quote", "orders", "supabase"],
  async (ctx) => {
    const branchVendor = await ctx.fixtures.createVendor();
    await ctx.db.patchRows(
      "vendors",
      { id: `eq.${branchVendor.vendorId}` },
      {
        parent_vendor_id: ctx.baseVendor.vendorId,
      },
    );
    const branchVendorRow = await ctx.db.selectOne<Record<string, unknown>>("vendors", {
      select: "id,root_vendor_id",
      id: `eq.${branchVendor.vendorId}`,
    });
    assert.equal(branchVendorRow?.root_vendor_id, ctx.baseVendor.vendorId);

    const branchProduct = await ctx.fixtures.createProduct(branchVendor.vendorId, {
      name: "QA Branch Shipping Product",
      base_price: 120,
    });
    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const methodId = assertString(cvsMethod?.id, "cvs platform shipping method id");

    const quoteResponse = await callJson(
      ctx.handlers,
      "haiglobals-checkout-quote",
      {
        items: [{ productId: branchProduct.productId, quantity: 1 }],
        shippingSelections: [
          {
            vendorId: branchVendor.vendorId,
            shippingMethodId: methodId,
          },
        ],
      },
      { accessToken: ctx.auth.accessToken },
    );
    const quoteJson = await expectJson<Record<string, unknown>>(quoteResponse, 200);
    const quoteVendors = quoteJson.vendors as Array<Record<string, unknown>>;
    assert.equal(quoteVendors[0]?.vendorId, branchVendor.vendorId);
    assert.equal(quoteVendors[0]?.shippingMethodId, methodId);

    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: branchProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    assert.ok(created.orderId);

    const orderItem = await ctx.db.selectOne<Record<string, unknown>>("order_items", {
      select: "vendor_id",
      order_id: `eq.${created.orderId}`,
      limit: 1,
    });
    const shipment = await ctx.db.selectOne<Record<string, unknown>>("order_shipments", {
      select: "vendor_id,shipping_method_id",
      order_id: `eq.${created.orderId}`,
      limit: 1,
    });
    assert.equal(orderItem?.vendor_id, branchVendor.vendorId);
    assert.equal(shipment?.vendor_id, branchVendor.vendorId);
    assert.equal(shipment?.shipping_method_id, methodId);
  },
);

test(
  "checkout quote and order use stock owner product stock",
  ["checkout", "quote", "orders", "supabase"],
  async (ctx) => {
    const ownerProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA Stock Owner Product",
      base_price: 200,
      stock: 3,
    });
    const branchProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA Shared Stock Branch Product",
      base_price: 200,
      stock: 0,
      stock_owner_product_id: ownerProduct.productId,
    });

    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const methodId = assertString(cvsMethod?.id, "cvs platform shipping method id");

    const quoteResponse = await callJson(
      ctx.handlers,
      "haiglobals-checkout-quote",
      {
        items: [{ productId: branchProduct.productId, quantity: 2 }],
        shippingSelections: [
          {
            vendorId: ctx.baseVendor.vendorId,
            shippingMethodId: methodId,
          },
        ],
      },
      { accessToken: ctx.auth.accessToken },
    );
    const quoteJson = await expectJson<Record<string, unknown>>(quoteResponse, 200);
    assert.equal(quoteJson.ok, true);
    assert.equal(Number(quoteJson.itemsSubtotal), 400);

    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: branchProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
      quantity: 2,
    });
    assert.ok(created.orderId);

    const ownerAfterCheckout = await ctx.db.selectOne<Record<string, unknown>>("products", {
      select: "stock",
      id: `eq.${ownerProduct.productId}`,
    });
    const branchAfterCheckout = await ctx.db.selectOne<Record<string, unknown>>("products", {
      select: "stock",
      id: `eq.${branchProduct.productId}`,
    });
    assert.equal(Number(ownerAfterCheckout?.stock), 1);
    assert.equal(Number(branchAfterCheckout?.stock), 0);
  },
);

test(
  "checkout quote and order use stock owner sku stock",
  ["checkout", "quote", "orders", "supabase"],
  async (ctx) => {
    const ownerProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA SKU Stock Owner Product",
      base_price: 300,
      stock: 5,
    });
    const branchProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA Shared Stock SKU Branch Product",
      base_price: 300,
      stock: 0,
      stock_owner_product_id: ownerProduct.productId,
    });
    const ownerSkuId = randomUUID();
    const branchSkuId = randomUUID();
    await ctx.db.insertOne(
      "sku",
      {
        id: ownerSkuId,
        product_id: ownerProduct.productId,
        name: "Owner Size",
        base_price: 300,
        stock: 0,
        is_active: true,
        image_url: "https://example.test/owner-sku.png",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { adaptive: false },
    );
    await ctx.db.insertOne(
      "sku",
      {
        id: branchSkuId,
        product_id: branchProduct.productId,
        name: "Branch Size",
        base_price: 300,
        stock: 0,
        source_sku_id: ownerSkuId,
        stock_owner_sku_id: ownerSkuId,
        is_active: true,
        image_url: "https://example.test/branch-sku.png",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { adaptive: false },
    );
    ctx.cleanup.defer(`delete sku ${branchSkuId}`, async () => {
      await ctx.db.deleteRows("sku", { id: `eq.${branchSkuId}` });
    });
    ctx.cleanup.defer(`delete sku ${ownerSkuId}`, async () => {
      await ctx.db.deleteRows("sku", { id: `eq.${ownerSkuId}` });
    });
    const restockLogId = randomUUID();
    await ctx.db.insertOne(
      "inventory_logs",
      {
        id: restockLogId,
        product_id: ownerProduct.productId,
        sku_id: ownerSkuId,
        change_amount: 5,
        reason: "purchase_restock",
        note: "QA shared stock owner sku restock",
        created_at: new Date().toISOString(),
      },
      { adaptive: false },
    );
    ctx.cleanup.defer(`delete inventory_log ${restockLogId}`, async () => {
      await ctx.db.deleteRows("inventory_logs", { id: `eq.${restockLogId}` });
    });

    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const methodId = assertString(cvsMethod?.id, "cvs platform shipping method id");

    const quoteResponse = await callJson(
      ctx.handlers,
      "haiglobals-checkout-quote",
      {
        items: [{ productId: branchProduct.productId, skuId: branchSkuId, quantity: 2 }],
        shippingSelections: [
          {
            vendorId: ctx.baseVendor.vendorId,
            shippingMethodId: methodId,
          },
        ],
      },
      { accessToken: ctx.auth.accessToken },
    );
    const quoteJson = await expectJson<Record<string, unknown>>(quoteResponse, 200);
    assert.equal(quoteJson.ok, true);
    assert.equal(Number(quoteJson.itemsSubtotal), 600);

    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: branchProduct.productId,
      skuId: branchSkuId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
      quantity: 2,
    });
    assert.ok(created.orderId);

    const ownerSkuAfterCheckout = await ctx.db.selectOne<Record<string, unknown>>("sku", {
      select: "stock",
      id: `eq.${ownerSkuId}`,
    });
    const branchSkuAfterCheckout = await ctx.db.selectOne<Record<string, unknown>>("sku", {
      select: "stock",
      id: `eq.${branchSkuId}`,
    });
    assert.equal(Number(ownerSkuAfterCheckout?.stock), 3);
    assert.equal(Number(branchSkuAfterCheckout?.stock), 0);
  },
);

test(
  "haiglobals-ecpay-checkout converts foreign currency product totals into TWD",
  ["checkout", "orders", "supabase"],
  async (ctx) => {
    await ctx.fixtures.createExchangeRate({ toCurrency: "USD", rate: 0.03125 });
    const usdProduct = await ctx.fixtures.createProduct(ctx.baseVendor.vendorId, {
      name: "QA USD Checkout Product",
      base_price: 10,
      currency: "USD",
    });

    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: usdProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(Number(order.items_subtotal), 320);
    assert.equal(Number(order.shipping_fee), 60);
    assert.equal(Number(order.total_amount), 380);
    assert.equal(order.currency, "TWD");

    const orderItem = await ctx.db.selectOne<Record<string, unknown>>("order_items", {
      select: "unit_price,currency",
      order_id: `eq.${created.orderId}`,
      limit: 1,
    });
    assert.equal(Number(orderItem?.unit_price ?? 0), 320);
    assert.equal(orderItem?.currency, "TWD");
  },
);

test(
  "haiglobals-ecpay-checkout uses vendor shipping fee override for orders",
  ["checkout", "orders", "supabase"],
  async (ctx) => {
    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const methodId = assertString(cvsMethod?.id, "cvs platform shipping method id");

    await ctx.db.patchRows(
      "platform_shipping_methods",
      { id: `eq.${methodId}` },
      { shipping_fee: 80 },
    );
    await ctx.db.patchRows(
      "vendor_shipping_methods",
      {
        vendor_id: `eq.${ctx.baseVendor.vendorId}`,
        shipping_method_id: `eq.${methodId}`,
      },
      { shipping_fee_override: 150 },
    );

    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(Number(order.shipping_fee), 150);
    assert.equal(Number(order.total_amount), Number(order.items_subtotal) + 150);

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(Number(shipment.shipping_fee), 150);
  },
);

test(
  "haiglobals-ecpay-checkout creates credit CVS order from checkoutDraft",
  ["checkout", "orders", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    assert.ok(created.orderId);

    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(created.amount, Number(order.total_amount));
    assert.equal(Number(order.items_subtotal), 120);
    assert.equal(order.payment_status, "pending");
    assert.equal(order.payment_provider, "ecpay");
    assert.ok(String(order.provider_order_id ?? "").startsWith("OSE"));

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.logistics_type, "CVS");
    assert.equal(shipment.logistics_sub_type, "UNIMARTC2C");
  },
);

test(
  "haiglobals-ecpay-checkout creates vendor-specific shipments from shippingSelections",
  ["checkout", "orders", "supabase"],
  async (ctx) => {
    const secondVendor = await ctx.fixtures.createVendor();
    await ctx.fixtures.ensureVendorShippingMethods(secondVendor.vendorId);
    const secondProduct = await ctx.fixtures.createProduct(secondVendor.vendorId, {
      name: "QA Second Vendor Product",
      base_price: 80,
    });
    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const manualMethod = await ctx.db.selectOne<Record<string, unknown>>(
      "platform_shipping_methods",
      {
        select: "id",
        provider: "eq.manual",
        logistics_type: "eq.HOME",
        logistics_sub_type: "eq.MANUAL",
        enabled: "eq.true",
      },
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "credit",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          recipientCountryCode: "TW",
          recipientZipcode: "100",
          invoiceType: "personal",
          items: [
            { productId: ctx.baseProduct.productId, quantity: 1 },
            { productId: secondProduct.productId, quantity: 1 },
          ],
          shippingSelections: [
            {
              vendorId: ctx.baseVendor.vendorId,
              shippingMethodId: assertString(cvsMethod?.id, "cvs platform shipping method id"),
              deliveryMethod: "cvs",
              logisticsSubType: "UNIMARTC2C",
              pickupStoreCode: "991182",
              pickupStoreName: "測試門市 A",
              pickupStoreAddress: "台北市測試門市 A",
            },
            {
              vendorId: secondVendor.vendorId,
              shippingMethodId: assertString(
                manualMethod?.id,
                "manual platform shipping method id",
              ),
              deliveryMethod: "home_delivery",
              logisticsSubType: "MANUAL",
              recipientAddress: "高雄市前鎮區測試路 2 號",
              recipientZipcode: "806",
            },
          ],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(json.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);

    const order = await ctx.fixtures.getOrder(orderId);
    assert.equal(Number(order.items_subtotal), 200);
    assert.equal(
      Number(order.total_amount),
      Number(order.items_subtotal) + Number(order.shipping_fee),
    );

    const shipments = await ctx.db.selectRows<Record<string, unknown>>("order_shipments", {
      select: "*",
      order_id: `eq.${orderId}`,
    });
    assert.equal(shipments.length, 2);

    const baseShipment = shipments.find(
      (shipment) => String(shipment.vendor_id) === ctx.baseVendor.vendorId,
    );
    const secondShipment = shipments.find(
      (shipment) => String(shipment.vendor_id) === secondVendor.vendorId,
    );
    assert.equal(baseShipment?.logistics_type, "CVS");
    assert.equal(baseShipment?.logistics_sub_type, "UNIMARTC2C");
    assert.equal(baseShipment?.cvs_store_id, "991182");
    assert.equal(secondShipment?.shipping_provider, "manual");
    assert.equal(secondShipment?.logistics_type, "HOME");
    assert.equal(secondShipment?.logistics_sub_type, "MANUAL");
    assert.equal(secondShipment?.receiver_address, "高雄市前鎮區測試路 2 號");
  },
);

test(
  "haiglobals-ecpay-checkout supports COD branch without ECPay redirect form",
  ["checkout", "cod", "orders"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "cod",
          deliveryMethod: "home_delivery",
          logisticsSubType: "MANUAL",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          invoiceType: "personal",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(json.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);
    assert.equal(json.cod, true);
    assert.equal(json.paymentMethod, "cod");
    assert.equal(json.action, undefined);
  },
);

test(
  "haiglobals-ecpay-checkout rejects COD when shipping method does not support collection",
  ["checkout", "cod", "validation"],
  async (ctx) => {
    const { logisticsSubType } = await createNoCodShippingMethod(ctx);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "cod",
          deliveryMethod: "home_delivery",
          logisticsSubType,
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          invoiceType: "personal",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Shipping method does not support COD collection");
    assertIncludes(String(json.error), `ecpay/HOME/${logisticsSubType}`);
  },
);

test(
  "haiglobals-ecpay-checkout creates ATM checkout fields with PaymentInfoURL",
  ["checkout", "atm", "orders", "supabase"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "atm",
          deliveryMethod: "home_delivery",
          logisticsSubType: "MANUAL",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          recipientCountryCode: "TW",
          recipientZipcode: "100",
          invoiceType: "personal",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
        clientBackUrl: "https://frontend.test/#/pay",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(json.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);

    const fields = json.fields as Record<string, string>;
    assert.equal(fields.ChoosePayment, "ATM");
    assert.ok(fields.PaymentInfoURL.endsWith("/haiglobals-ecpay-return"));
    assert.equal(fields.ClientBackURL, "https://frontend.test/#/pay");

    const order = await ctx.fixtures.getOrder(orderId);
    assert.equal(order.payment_method, "atm");
    assert.equal(order.payment_status, "pending");
  },
);

test(
  "haiglobals-ecpay-checkout persists company invoice fields",
  ["checkout", "invoice", "supabase"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "credit",
          deliveryMethod: "home_delivery",
          logisticsSubType: "MANUAL",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 2 號",
          recipientCountryCode: "TW",
          recipientZipcode: "100",
          invoiceType: "company",
          invoiceCompanyTitle: "測試股份有限公司",
          invoiceTaxId: "24536806",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(json.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);

    const invoice = await ctx.fixtures.getInvoice(orderId);
    assert.equal(invoice?.invoice_type, "company");
    assert.equal(invoice?.invoice_company_title, "測試股份有限公司");
    assert.equal(invoice?.invoice_tax_id, "24536806");
  },
);

test(
  "haiglobals-ecpay-checkout rejects unsupported payment method",
  ["checkout", "validation"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "paypal",
          deliveryMethod: "cvs",
          logisticsSubType: "UNIMARTC2C",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          pickupStoreCode: "991182",
          invoiceType: "personal",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Unsupported paymentMethod");
  },
);

test(
  "haiglobals-ecpay-checkout rejects amount mismatch on existing order",
  ["checkout", "validation", "orders"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        orderId: created.orderId,
        amount: created.amount + 1,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Amount mismatch");
  },
);

test(
  "haiglobals-ecpay-return rejects invalid CheckMacValue",
  ["payment-return", "security"],
  async (ctx) => {
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-return", {
      MerchantID: process.env.ECPAY_MERCHANT_ID,
      MerchantTradeNo: "OSEQA0000000001",
      RtnCode: "1",
      CheckMacValue: "BAD",
    });
    await expectStatus(response, 400);
    assertIncludes(await responseText(response), "CheckMacValue Error");
  },
);

test(
  "haiglobals-ecpay-return marks successful credit payment as paid and auto issues invoice",
  ["payment-return", "orders", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const order = await ctx.fixtures.getOrder(created.orderId);
    const merchantTradeNo = assertString(order.provider_order_id, "provider_order_id");
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(merchantTradeNo, created.amount),
    );

    const response = await callForm(ctx.handlers, "haiglobals-ecpay-return", payload);
    await expectStatus(response, 200);
    assert.equal(await responseText(response), "1|OK");

    const updatedOrder = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(updatedOrder.payment_status, "paid");
    assert.equal(updatedOrder.provider_transaction_id, payload.TradeNo);

    const invoice = await ctx.fixtures.getInvoice(created.orderId);
    assert.equal(invoice?.invoice_provider, "ecpay");
    assert.equal(invoice?.invoice_status, "issued");
    assertString(invoice?.invoice_number, "invoice_number");
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);

    await ctx.fixtures.ensureAdminRole();
    const duplicateResponse = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-order-invoice",
      {
        orderId: created.orderId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const duplicateJson = await expectJson<Record<string, unknown>>(
      duplicateResponse,
      200,
      "idempotent admin order invoice",
    );
    assert.equal(duplicateJson.provider, "ecpay");
    assert.equal(duplicateJson.orderId, created.orderId);
    assert.equal(duplicateJson.skipped, true);
    assert.equal(duplicateJson.invoiceNo, invoice?.invoice_number);
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);
  },
);

test(
  "haiglobals-ecpay-return skips invoice when checkout omits invoice fields",
  ["checkout", "payment-return", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "credit",
          deliveryMethod: "home_delivery",
          logisticsSubType: "MANUAL",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          recipientCountryCode: "TW",
          recipientZipcode: "100",
          items: [{ productId: ctx.baseProduct.productId, quantity: 1 }],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(json.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);
    assert.equal(await ctx.fixtures.getInvoice(orderId), null);

    const order = await ctx.fixtures.getOrder(orderId);
    const merchantTradeNo = assertString(order.provider_order_id, "provider_order_id");
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(merchantTradeNo, Number(order.total_amount)),
    );

    const callbackResponse = await callForm(ctx.handlers, "haiglobals-ecpay-return", payload);
    await expectStatus(callbackResponse, 200);
    assert.equal(await responseText(callbackResponse), "1|OK");

    const updatedOrder = await ctx.fixtures.getOrder(orderId);
    assert.equal(updatedOrder.payment_status, "paid");
    assert.equal(await ctx.fixtures.getInvoice(orderId), null);
    assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
  },
);

test(
  "haiglobals-ecpay-return stores simulated callback without marking order paid",
  ["payment-return", "orders"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const order = await ctx.fixtures.getOrder(created.orderId);
    const merchantTradeNo = assertString(order.provider_order_id, "provider_order_id");
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(merchantTradeNo, created.amount, {
        SimulatePaid: "1",
        RtnMsg: "模擬付款",
      }),
    );

    const response = await callForm(ctx.handlers, "haiglobals-ecpay-return", payload);
    await expectStatus(response, 200);
    const updatedOrder = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(updatedOrder.payment_status, "pending");
    assertIncludes(String(updatedOrder.provider_status_message), "[SIMULATED]");
  },
);

test(
  "haiglobals-ecpay-return marks failed payment callback as failed",
  ["payment-return", "orders", "failure"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const order = await ctx.fixtures.getOrder(created.orderId);
    const merchantTradeNo = assertString(order.provider_order_id, "provider_order_id");
    const payload = await paymentSignedPayload({
      MerchantTradeNo: merchantTradeNo,
      RtnCode: "0",
      RtnMsg: "交易失敗",
      TradeNo: `QAFAIL${Date.now().toString().slice(-8)}`,
      TradeAmt: String(created.amount),
      PaymentDate: "",
      PaymentType: "Credit_CreditCard",
      TradeDate: "2026/01/01 11:59:00",
      SimulatePaid: "0",
    });

    const response = await callForm(ctx.handlers, "haiglobals-ecpay-return", payload);
    await expectStatus(response, 200);

    const updatedOrder = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(updatedOrder.payment_status, "failed");
    assert.equal(updatedOrder.provider_transaction_id, payload.TradeNo);
    assert.equal(Number(updatedOrder.provider_status_code), 0);
  },
);

test(
  "haiglobals-ecpay-return records ATM payment info without marking paid",
  ["payment-return", "atm", "orders", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      paymentMethod: "atm",
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    const order = await ctx.fixtures.getOrder(created.orderId);
    const merchantTradeNo = assertString(order.provider_order_id, "provider_order_id");
    const payload = await paymentSignedPayload({
      MerchantTradeNo: merchantTradeNo,
      RtnCode: "2",
      RtnMsg: "取號成功",
      TradeNo: `QAATM${Date.now().toString().slice(-8)}`,
      TradeAmt: String(created.amount),
      PaymentDate: "",
      PaymentType: "ATM_TAISHIN",
      TradeDate: "2026/01/01 11:59:00",
      SimulatePaid: "0",
      BankCode: "812",
      vAccount: "12345678901234",
      ExpireDate: "2026/01/07",
    });

    const response = await callForm(ctx.handlers, "haiglobals-ecpay-return", payload);
    await expectStatus(response, 200);

    const updatedOrder = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(updatedOrder.payment_status, "pending");
    assert.equal(updatedOrder.bank_code, "812");
    assert.equal(updatedOrder.virtual_account, "12345678901234");
    assertIncludes(String(updatedOrder.payment_deadline), "2026-01-07");
  },
);

// -----------------------------------------------------------------------------
// Logistics shipment creation and logistics notify.
// -----------------------------------------------------------------------------

test(
  "haiglobals-ecpay-create-shipment rejects missing auth",
  ["create-shipment", "auth"],
  async (ctx) => {
    const response = await callJson(ctx.handlers, "haiglobals-ecpay-create-shipment", {
      orderId: randomUUID(),
      vendorId: ctx.baseVendor.vendorId,
    });
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Missing bearer token");
  },
);

test(
  "haiglobals-ecpay-create-shipment rejects unpaid non-COD order",
  ["create-shipment", "validation"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "0912345678",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Only paid or COD orders can have shipments created");
    assert.equal(ctx.ecpay.count("logisticsCreate"), 0);
  },
);

test(
  "haiglobals-ecpay-shipment-label includes translated ECPay language",
  ["shipment-label", "logistics", "language", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    await markOrderPaid(ctx, created.orderId);
    await expectJson(
      await callJson(
        ctx.handlers,
        "haiglobals-ecpay-create-shipment",
        {
          orderId: created.orderId,
          vendorId: ctx.baseVendor.vendorId,
          senderName: "測試賣家",
          senderPhone: "0912345678",
        },
        { accessToken: ctx.auth.accessToken },
      ),
      200,
    );

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-shipment-label",
      {
        shipmentId: assertString(shipment.id, "shipment.id"),
        vendorId: ctx.baseVendor.vendorId,
        printMode: 1,
        cvsPaymentNo: "QA-CVS-001",
        cvsValidationNo: "1234",
        language: "ja-JP",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    const fields = json.fields as Record<string, string>;
    assert.equal(fields.Language, "JPN");
    assert.ok(fields.CheckMacValue);
  },
);

test(
  "haiglobals-ecpay-create-shipment creates CVS shipment with mocked ECPay response",
  ["create-shipment", "logistics", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "0912345678",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.ok(ctx.ecpay.count("logisticsCreate") >= 1);

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_status, "created");
    assert.equal(shipment.shipped_at ?? null, null);
    assert.equal(shipment.provider_logistics_id, "QA123456789");
    assert.equal(shipment.tracking_no, "QA-BOOKING-001");
  },
);

test(
  "haiglobals-ecpay-create-shipment rejects non-pending shipment",
  ["create-shipment", "validation"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    await ctx.fixtures.patchShipment(assertString(shipment.id, "shipment.id"), {
      shipping_status: "created",
    });

    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "0912345678",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Only pending shipments can have ECPay logistics created");
    assert.equal(ctx.ecpay.count("logisticsCreate"), 0);
  },
);

test(
  "haiglobals-ecpay-create-shipment normalizes +886 mobile numbers for ECPay",
  ["create-shipment", "logistics", "validation", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
      recipientPhone: "+886 0912 345 678",
    });

    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "+886 0912-345-678",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);

    const logisticsCreateCall = ctx.ecpay.last("logisticsCreate");
    assert.ok(logisticsCreateCall);
    const fields = Object.fromEntries(new URLSearchParams(logisticsCreateCall.body).entries());
    assert.equal(fields.SenderCellPhone, "0912345678");
    assert.equal(fields.ReceiverCellPhone, "0912345678");

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.sender_phone, "+886912345678");
    assert.equal(shipment.receiver_phone, "+886912345678");
  },
);

test(
  "haiglobals-ecpay-create-shipment rejects invalid sender phone",
  ["create-shipment", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });

    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "12345",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "senderPhone must be a Taiwan mobile number");
  },
);

test(
  "haiglobals-ecpay-create-shipment rejects HOME/MANUAL shipment",
  ["create-shipment", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        senderName: "測試賣家",
        senderPhone: "0912345678",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Only CVS C2C logistics is supported");
  },
);

test(
  "haiglobals-ecpay-logistics-notify rejects invalid CheckMacValue",
  ["logistics-notify", "security"],
  async (ctx) => {
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-notify", {
      MerchantTradeNo: "OSLQA0000000003",
      LogisticsSubType: "UNIMARTC2C",
      LogisticsStatus: "2073",
      CheckMacValue: "BAD",
    });
    await expectStatus(response, 400);
    assertIncludes(await responseText(response), "CheckMacValue Error");
  },
);

test(
  "haiglobals-ecpay-logistics-notify maps order-created status from signed callback",
  ["logistics-notify", "logistics", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    const shipmentId = assertString(shipment.id, "shipment.id");
    const tempLogisticsId = `OSL${Date.now().toString().slice(-12)}30`;
    await ctx.fixtures.patchShipment(shipmentId, {
      temp_logistics_id: tempLogisticsId,
      provider_logistics_id: null,
      shipping_status: "pending",
      shipped_at: null,
    });

    const payload = await logisticsSignedPayload({
      MerchantTradeNo: tempLogisticsId,
      AllPayLogisticsID: "QA-LOGISTICS-300",
      BookingNote: "QA-BOOKING-300",
      LogisticsSubType: "UNIMARTC2C",
      LogisticsStatus: "300",
      UpdateStatusDate: "2026/01/01 12:30:00",
      GoodsAmount: String(created.amount),
    });
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-notify", payload);
    await expectStatus(response, 200);

    const updated = await ctx.fixtures.getShipmentByOrder(created.orderId, ctx.baseVendor.vendorId);
    assert.equal(updated.shipping_status, "created");
    assert.equal(updated.shipped_at ?? null, null);
    assert.ok(updated.last_logistics_callback_at);
  },
);

test(
  "haiglobals-ecpay-logistics-notify updates delivered status from signed callback",
  ["logistics-notify", "logistics", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    const shipmentId = assertString(shipment.id, "shipment.id");
    const tempLogisticsId = `OSL${Date.now().toString().slice(-12)}99`;
    await ctx.fixtures.patchShipment(shipmentId, {
      temp_logistics_id: tempLogisticsId,
      provider_logistics_id: null,
      shipping_status: "pending",
    });

    const payload = await logisticsSignedPayload({
      MerchantTradeNo: tempLogisticsId,
      AllPayLogisticsID: "QA-LOGISTICS-2073",
      BookingNote: "QA-BOOKING-2073",
      LogisticsSubType: "UNIMARTC2C",
      LogisticsStatus: "2073",
      UpdateStatusDate: "2026/01/01 13:00:00",
      GoodsAmount: String(created.amount),
    });
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-notify", payload);
    await expectStatus(response, 200);
    assert.equal(await responseText(response), "1|OK");

    const updated = await ctx.fixtures.getShipmentByOrder(created.orderId, ctx.baseVendor.vendorId);
    assert.equal(updated.shipping_status, "delivered");
    assert.equal(updated.provider_logistics_id, "QA-LOGISTICS-2073");
    assert.equal(updated.tracking_no, "QA-BOOKING-2073");
  },
);

test(
  "haiglobals-ecpay-logistics-notify maps picked-up status from signed callback",
  ["logistics-notify", "logistics", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "cvs",
      logisticsSubType: "UNIMARTC2C",
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    const shipmentId = assertString(shipment.id, "shipment.id");
    const tempLogisticsId = `OSL${Date.now().toString().slice(-12)}66`;
    await ctx.fixtures.patchShipment(shipmentId, {
      temp_logistics_id: tempLogisticsId,
      provider_logistics_id: null,
      shipping_status: "delivered",
    });

    const payload = await logisticsSignedPayload({
      MerchantTradeNo: tempLogisticsId,
      AllPayLogisticsID: "QA-LOGISTICS-2067",
      BookingNote: "QA-BOOKING-2067",
      LogisticsSubType: "UNIMARTC2C",
      LogisticsStatus: "2067",
      UpdateStatusDate: "2026/01/01 14:00:00",
      GoodsAmount: String(created.amount),
    });
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-logistics-notify", payload);
    await expectStatus(response, 200);

    const updated = await ctx.fixtures.getShipmentByOrder(created.orderId, ctx.baseVendor.vendorId);
    assert.equal(updated.shipping_status, "picked-up");
    assert.equal(updated.tracking_no, "QA-BOOKING-2067");
    assert.ok(updated.picked_up_at);
  },
);

// -----------------------------------------------------------------------------
// Manual shipment updates and buyer order actions.
// -----------------------------------------------------------------------------

test(
  "haiglobals-manual-create-shipment rejects unpaid non-COD order",
  ["manual-shipment", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      paymentMethod: "credit",
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-manual-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Only paid or COD orders can have shipments created");

    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_status, "pending");
  },
);

test(
  "haiglobals-manual-create-shipment marks HOME/MANUAL shipment as created",
  ["manual-shipment", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-manual-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_provider, "manual");
    assert.equal(shipment.shipping_status, "created");
    assert.equal(shipment.shipped_at ?? null, null);
  },
);

test(
  "haiglobals-manual-update-shipment marks created HOME/MANUAL shipment as shipped without changing provider",
  ["manual-shipment", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    await markOrderPaid(ctx, created.orderId);
    await callJson(
      ctx.handlers,
      "haiglobals-manual-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
      },
      { accessToken: ctx.auth.accessToken },
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-manual-update-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        shippingProvider: "tcat",
        trackingNo: "QA-TRACK-001",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_provider, "manual");
    assert.equal(shipment.shipping_status, "shipped");
    assert.equal(shipment.tracking_no, "QA-TRACK-001");
  },
);

test(
  "haiglobals-manual-update-shipment does not require shippingProvider",
  ["manual-shipment", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    await markOrderPaid(ctx, created.orderId);
    await callJson(
      ctx.handlers,
      "haiglobals-manual-create-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
      },
      { accessToken: ctx.auth.accessToken },
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-manual-update-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        trackingNo: "QA-TRACK-002",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_provider, "manual");
    assert.equal(shipment.tracking_no, "QA-TRACK-002");
  },
);

test(
  "haiglobals-order-actions confirm_received marks shipped order picked-up",
  ["order-actions", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    await ctx.fixtures.patchShipment(assertString(shipment.id, "shipment.id"), {
      shipping_status: "shipped",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-actions",
      {
        action: "confirm_received",
        orderId: created.orderId,
        shipmentId: assertString(shipment.id, "shipment.id"),
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    const updated = await ctx.fixtures.getShipmentByOrder(created.orderId, ctx.baseVendor.vendorId);
    assert.equal(updated.shipping_status, "picked-up");
  },
);

test(
  "haiglobals-order-actions confirm_received targets requested shipment when order has multiple shipments",
  ["order-actions", "supabase"],
  async (ctx) => {
    const secondVendor = await ctx.fixtures.createVendor();
    await ctx.fixtures.ensureVendorShippingMethods(secondVendor.vendorId);
    const secondProduct = await ctx.fixtures.createProduct(secondVendor.vendorId, {
      name: "QA Confirm Received Second Product",
      base_price: 80,
    });
    const cvsMethod = await ctx.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
      select: "id",
      provider: "eq.ecpay",
      logistics_type: "eq.CVS",
      logistics_sub_type: "eq.UNIMARTC2C",
      enabled: "eq.true",
    });
    const manualMethod = await ctx.db.selectOne<Record<string, unknown>>(
      "platform_shipping_methods",
      {
        select: "id",
        provider: "eq.manual",
        logistics_type: "eq.HOME",
        logistics_sub_type: "eq.MANUAL",
        enabled: "eq.true",
      },
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-checkout",
      {
        checkoutDraft: {
          paymentProvider: "ecpay",
          paymentMethod: "credit",
          recipientName: "測試收件人",
          recipientPhone: "0912345678",
          recipientAddress: "台北市中正區測試路 1 號",
          recipientCountryCode: "TW",
          recipientZipcode: "100",
          invoiceType: "personal",
          items: [
            { productId: ctx.baseProduct.productId, quantity: 1 },
            { productId: secondProduct.productId, quantity: 1 },
          ],
          shippingSelections: [
            {
              vendorId: ctx.baseVendor.vendorId,
              shippingMethodId: assertString(cvsMethod?.id, "cvs platform shipping method id"),
              deliveryMethod: "cvs",
              logisticsSubType: "UNIMARTC2C",
              pickupStoreCode: "991182",
              pickupStoreName: "測試門市 A",
              pickupStoreAddress: "台北市測試門市 A",
            },
            {
              vendorId: secondVendor.vendorId,
              shippingMethodId: assertString(
                manualMethod?.id,
                "manual platform shipping method id",
              ),
              deliveryMethod: "home_delivery",
              logisticsSubType: "MANUAL",
              recipientAddress: "高雄市前鎮區測試路 2 號",
              recipientZipcode: "806",
            },
          ],
        },
      },
      { accessToken: ctx.auth.accessToken },
    );
    const checkoutJson = await expectJson<Record<string, unknown>>(response, 200);
    const orderId = assertString(checkoutJson.orderId, "orderId");
    ctx.fixtures.registerOrderCleanup(orderId);

    const shipments = await ctx.db.selectRows<Record<string, unknown>>("order_shipments", {
      select: "id,vendor_id,shipping_status",
      order_id: "eq." + orderId,
    });
    const baseShipment = shipments.find(
      (shipment) => String(shipment.vendor_id) === ctx.baseVendor.vendorId,
    );
    const secondShipment = shipments.find(
      (shipment) => String(shipment.vendor_id) === secondVendor.vendorId,
    );
    const baseShipmentId = assertString(baseShipment?.id, "base shipment.id");
    const secondShipmentId = assertString(secondShipment?.id, "second shipment.id");
    await ctx.fixtures.patchShipment(secondShipmentId, { shipping_status: "shipped" });

    const confirmResponse = await callJson(
      ctx.handlers,
      "haiglobals-order-actions",
      {
        action: "confirm_received",
        orderId,
        shipment_id: secondShipmentId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const confirmJson = await expectJson<Record<string, unknown>>(confirmResponse, 200);
    assert.equal(confirmJson.ok, true);

    const baseUpdated = await ctx.db.selectOne<Record<string, unknown>>("order_shipments", {
      select: "id,shipping_status",
      id: "eq." + baseShipmentId,
    });
    const secondUpdated = await ctx.db.selectOne<Record<string, unknown>>("order_shipments", {
      select: "id,shipping_status",
      id: "eq." + secondShipmentId,
    });
    assert.equal(baseUpdated?.shipping_status, "pending");
    assert.equal(secondUpdated?.shipping_status, "picked-up");
  },
);

test(
  "haiglobals-order-actions confirm_received rejects pending shipment",
  ["order-actions", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-actions",
      {
        action: "confirm_received",
        orderId: created.orderId,
        shipmentId: assertString(shipment.id, "shipment.id"),
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "not eligible");
  },
);

test(
  "haiglobals-manual-update-shipment rejects pending shipment",
  ["manual-shipment", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
      deliveryMethod: "home_delivery",
      logisticsSubType: "MANUAL",
    });

    await markOrderPaid(ctx, created.orderId);
    const response = await callJson(
      ctx.handlers,
      "haiglobals-manual-update-shipment",
      {
        orderId: created.orderId,
        vendorId: ctx.baseVendor.vendorId,
        shippingProvider: "tcat",
        trackingNo: "QA-TRACK-003",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Only created shipments can be manually shipped");
  },
);

test(
  "haiglobals-order-actions rejects unsupported action",
  ["order-actions", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-actions",
      {
        action: "archive_order",
        orderId: created.orderId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Unsupported action");
  },
);

test(
  "haiglobals-ecpay-invoice-print includes translated ECPay language",
  ["invoice-print", "invoice", "language", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    await ctx.fixtures.patchInvoice(created.orderId, {
      invoice_provider: "ecpay",
      invoice_status: "issued",
      invoice_number: `QA${Date.now().toString().slice(-8)}`,
      invoice_issued_at: "2026-01-01T04:00:00.000Z",
      invoice_random_number: "1234",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-invoice-print",
      {
        invoiceTarget: "order",
        orderId: created.orderId,
        printStyle: 1,
        isShowingDetail: 1,
        language: "en-US",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.equal(json.provider, "ecpay");

    const printCall = ctx.ecpay.last("invoicePrint");
    assert.ok(printCall);
    const envelope = JSON.parse(printCall.body) as Record<string, unknown>;
    const printData = (await decryptInvoiceData(
      String(envelope.Data ?? ""),
      process.env.ECPAY_INVOICE_HASH_KEY ?? "",
      process.env.ECPAY_INVOICE_HASH_IV ?? "",
    )) as Record<string, unknown>;
    assert.equal(printData.Language, "ENG");
  },
);

// -----------------------------------------------------------------------------
// Buyer order cancellation, refund, invoice invalidation.
// -----------------------------------------------------------------------------

test(
  "haiglobals-order-cancel cancels pending order and pending shipments",
  ["order-cancel", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
        reason: "QA pending cancel",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.equal(json.paymentStatus, "cancelled");
    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(order.payment_status, "cancelled");
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    assert.equal(shipment.shipping_status, "cancelled");
  },
);

test(
  "haiglobals-order-cancel cancels pending order with no shipments",
  ["order-cancel", "supabase"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    await ctx.db.deleteRows("order_shipments", { order_id: "eq." + created.orderId });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
        reason: "QA pending cancel without shipment",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.equal(json.paymentStatus, "cancelled");
    assert.equal(json.checkedShipments, 0);
    assert.equal(json.cancelledShipments, 0);

    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(order.payment_status, "cancelled");
  },
);

test(
  "haiglobals-order-cancel is idempotent for already-cancelled orders",
  ["order-cancel", "idempotency"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
        reason: "QA first cancel",
      },
      { accessToken: ctx.auth.accessToken },
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
        reason: "QA second cancel",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.alreadyCancelled, true);
  },
);

test(
  "haiglobals-order-cancel refunds paid ECPay credit order and voids issued invoice",
  ["order-cancel", "refund", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    await ctx.fixtures.patchOrder(created.orderId, {
      payment_status: "paid",
      payment_provider: "ecpay",
      payment_method: "credit_card",
      provider_order_id: `OSE${Date.now().toString().slice(-12)}88`,
      provider_transaction_id: `QA-TRADE-${Date.now().toString().slice(-8)}`,
      paid_at: new Date().toISOString(),
    });
    await ctx.fixtures.patchInvoice(created.orderId, {
      invoice_provider: "ecpay",
      invoice_status: "issued",
      invoice_number: `QA${Date.now().toString().slice(-8)}`,
      invoice_issued_at: "2026-01-01T04:00:00.000Z",
      invoice_random_number: "1234",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
        reason: "QA refund cancel",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.equal(json.paymentStatus, "refunded");
    assert.ok(ctx.ecpay.count("creditAction") >= 1);
    assert.ok(ctx.ecpay.count("invoiceInvalid") >= 1);

    const order = await ctx.fixtures.getOrder(created.orderId);
    assert.equal(order.payment_status, "refunded");
    const refunds = await ctx.db.selectRows<Record<string, unknown>>("order_refunds", {
      select: "*",
      order_id: `eq.${created.orderId}`,
    });
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].status, "success");
  },
);

test(
  "haiglobals-order-cancel blocks cancellation when any shipment is not pending",
  ["order-cancel", "validation"],
  async (ctx) => {
    const created = await ctx.fixtures.createOrderViaCheckout({
      productId: ctx.baseProduct.productId,
    });
    const shipment = await ctx.fixtures.getShipmentByOrder(
      created.orderId,
      ctx.baseVendor.vendorId,
    );
    await ctx.fixtures.patchShipment(assertString(shipment.id, "shipment.id"), {
      shipping_status: "shipped",
    });

    const response = await callJson(
      ctx.handlers,
      "haiglobals-order-cancel",
      {
        orderId: created.orderId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(
      String(json.error),
      "Only orders whose every order_shipments.shipping_status is pending",
    );
  },
);

// -----------------------------------------------------------------------------
// Vendor subscription checkout, payment callbacks, cancellation.
// -----------------------------------------------------------------------------

test(
  "haiglobals-ecpay-vendor-subscription-checkout rejects missing vendorId/planCode",
  ["vendor-subscription", "checkout", "validation"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-checkout",
      {},
      {
        accessToken: ctx.auth.accessToken,
      },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "vendorId is required");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-checkout converts foreign currency plans into TWD",
  ["vendor-subscription", "checkout", "supabase"],
  async (ctx) => {
    await ctx.fixtures.createExchangeRate({ toCurrency: "USD", rate: 0.03125 });
    const plan = await ctx.fixtures.createSubscriptionPlan({
      amount: 10,
      currency: "USD",
      execTimes: 2,
    });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    assert.equal(checkout.amount, 320);
    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(Number(order.amount ?? 0), 320);
    assert.equal(order.currency, "TWD");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-checkout creates ECPay recurring subscription checkout",
  ["vendor-subscription", "checkout", "supabase"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 199, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    assert.equal(checkout.amount, 199);
    assert.equal(checkout.fields.PeriodAmount, "199");
    assert.equal(checkout.fields.ExecTimes, "3");
    assert.ok(
      checkout.fields.PeriodReturnURL?.endsWith("/haiglobals-ecpay-vendor-subscription-return"),
    );

    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(order.payment_status, "pending");
    assert.equal("purchase_mode" in order, false);
    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "pending");
    assert.equal("auto_renew" in subscription, false);
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-checkout rejects plans below recurring ExecTimes minimum",
  ["vendor-subscription", "checkout", "validation"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 188, execTimes: 1 });
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-checkout",
      {
        vendorId: ctx.baseVendor.vendorId,
        planCode: plan.planCode,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "Plan exec_times must be >= 2");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-checkout supersedes duplicate pending checkout for same plan",
  ["vendor-subscription", "checkout", "supabase"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 99, execTimes: 2 });
    const first = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    const second = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    assert.notEqual(second.subscriptionId, first.subscriptionId);
    assert.notEqual(second.subscriptionOrderId, first.subscriptionOrderId);

    const firstOrder = await latestVendorSubscriptionOrder(ctx.db, first.subscriptionOrderId);
    assert.equal(firstOrder.payment_status, "cancelled");
    assertIncludes(
      String(firstOrder.provider_status_message),
      "Superseded by vendor subscription checkout",
    );

    const firstSubscription = await getSubscription(ctx.db, first.subscriptionId);
    assert.equal(firstSubscription.status, "cancelled");
    // The superseded checkout must read as already expired, otherwise it still
    // counts as a current subscription and blocks the checkout that replaced it.
    assert.ok(new Date(String(firstSubscription.current_period_end)).getTime() <= Date.now());
    assert.ok(
      new Date(String(firstSubscription.current_period_end)).getTime() >
        new Date(String(firstSubscription.current_period_start)).getTime(),
    );

    const secondOrder = await latestVendorSubscriptionOrder(ctx.db, second.subscriptionOrderId);
    assert.equal(secondOrder.payment_status, "pending");
    const secondSubscription = await getSubscription(ctx.db, second.subscriptionId);
    assert.equal(secondSubscription.status, "pending");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-checkout includes translated ECPay language",
  ["vendor-subscription", "checkout", "language", "supabase"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 99, execTimes: 2 });
    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-checkout",
      {
        vendorId: ctx.baseVendor.vendorId,
        planCode: plan.planCode,
        language: "en-US",
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    const subscriptionId = assertString(json.subscriptionId, "subscriptionId");
    const subscriptionOrderId = assertString(json.subscriptionOrderId, "subscriptionOrderId");
    ctx.fixtures.registerSubscriptionCleanup(subscriptionOrderId, subscriptionId);
    const fields = json.fields as Record<string, string>;
    assert.equal(fields.Language, "ENG");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return rejects invalid CheckMacValue",
  ["vendor-subscription", "return", "security"],
  async (ctx) => {
    const response = await callForm(ctx.handlers, "haiglobals-ecpay-vendor-subscription-return", {
      MerchantID: process.env.ECPAY_MERCHANT_ID,
      MerchantTradeNo: "VSEQA0000000001",
      RtnCode: "1",
      CheckMacValue: "BAD",
    });
    await expectStatus(response, 400);
    assertIncludes(await responseText(response), "CheckMacValue invalid");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return returns 404 for signed unknown order",
  ["vendor-subscription", "return", "validation"],
  async (ctx) => {
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(`VSE${Date.now().toString().slice(-12)}77`, 99),
    );
    const response = await callForm(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-return",
      payload,
    );
    await expectStatus(response, 404);
    assertIncludes(await responseText(response), "Order not found");
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return auto-refunds superseded pending checkout",
  ["vendor-subscription", "return", "refund", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 120, execTimes: 2 });
    const first = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    const second = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    const response = await postVendorSubscriptionCallback(ctx, first, {
      TradeNo: "QA-SUPERSEDED-TRADE",
    });
    await expectStatus(response, 200);
    assert.equal(await responseText(response), "1|OK");

    const firstOrder = await latestVendorSubscriptionOrder(ctx.db, first.subscriptionOrderId);
    assert.equal(firstOrder.payment_status, "refunded");
    assert.equal(firstOrder.provider_trade_no, "QA-SUPERSEDED-TRADE");
    assertIncludes(String(firstOrder.provider_status_message), "Auto-refunded superseded checkout");

    const firstSubscription = await getSubscription(ctx.db, first.subscriptionId);
    assert.equal(firstSubscription.status, "cancelled");

    const secondOrder = await latestVendorSubscriptionOrder(ctx.db, second.subscriptionOrderId);
    assert.equal(secondOrder.payment_status, "pending");
    const secondSubscription = await getSubscription(ctx.db, second.subscriptionId);
    assert.equal(secondSubscription.status, "pending");

    const payments = await ctx.db.selectRows<Record<string, unknown>>(
      "vendor_subscription_payments",
      {
        select: "*",
        subscription_order_id: `eq.${first.subscriptionOrderId}`,
      },
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, "paid");
    assert.equal(ctx.ecpay.count("periodAction"), 1);
    assert.equal(ctx.ecpay.count("creditAction"), 1);
    assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
  },
);

test(
  "resolveInvoiceCustomer derives buyer name from vendor company or contact",
  ["vendor-subscription", "invoice"],
  async () => {
    // Company name present with a valid 8-digit 統編: company invoice with tax id.
    const company = resolveInvoiceCustomer(
      {
        id: "v1",
        company_name: "海樂全球股份有限公司",
        business_registration_no: "12345678",
        contact_name: "陳先生",
        contact_address: "台北市信義區信義路五段7號",
      },
      "vendor@example.test",
    );
    assert.equal(company.name, "海樂全球股份有限公司");
    assert.equal(company.identifier, "12345678");
    assert.equal(company.addr, "台北市信義區信義路五段7號");

    // Company name but no valid 統編: named invoice with no identifier, but the
    // address is still carried because Print=1 requires it.
    const companyNoTaxId = resolveInvoiceCustomer(
      {
        id: "v2",
        company_name: "海樂工作室",
        business_registration_no: "not-a-tax-id",
        contact_name: "林小姐",
        contact_address: "新北市板橋區",
      },
      "vendor2@example.test",
    );
    assert.equal(companyNoTaxId.name, "海樂工作室");
    assert.equal(companyNoTaxId.identifier, "");
    assert.equal(companyNoTaxId.addr, "新北市板橋區");

    // No company name: fall back to the contact person's name, keep the address.
    const individual = resolveInvoiceCustomer(
      {
        id: "v3",
        company_name: "",
        business_registration_no: "",
        contact_name: "王大明",
        contact_address: "高雄市",
      },
      "vendor3@example.test",
    );
    assert.equal(individual.name, "王大明");
    assert.equal(individual.identifier, "");
    assert.equal(individual.addr, "高雄市");
  },
  { needsSupabase: false },
);

test(
  "haiglobals-ecpay-vendor-subscription-return activates subscription and auto issues invoice",
  ["vendor-subscription", "return", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 150, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    const response = await postVendorSubscriptionCallback(ctx, checkout);
    await expectStatus(response, 200);
    assert.equal(await responseText(response), "1|OK");

    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(order.payment_status, "paid");
    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "active");

    const payments = await ctx.db.selectRows<Record<string, unknown>>(
      "vendor_subscription_payments",
      {
        select: "*",
        subscription_order_id: `eq.${checkout.subscriptionOrderId}`,
      },
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, "paid");
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);

    // ECPay rejects a printed invoice (Print=1) without a buyer name (1200021) or
    // address (1200023), so the subscription invoice must carry both from the
    // vendor record.
    const issueCall = ctx.ecpay.last("invoiceIssue");
    assert.ok(issueCall);
    const issueEnvelope = JSON.parse(issueCall.body) as Record<string, unknown>;
    const issueData = (await decryptInvoiceData(
      String(issueEnvelope.Data ?? ""),
      process.env.ECPAY_INVOICE_HASH_KEY ?? "",
      process.env.ECPAY_INVOICE_HASH_IV ?? "",
    )) as Record<string, unknown>;
    const vendorRow = await ctx.db.selectOne<Record<string, unknown>>("vendors", {
      select: "company_name,contact_address",
      id: `eq.${ctx.baseVendor.vendorId}`,
    });
    assert.equal(issueData.Print, "1");
    assert.equal(issueData.CustomerName, vendorRow?.company_name);
    assert.ok(String(issueData.CustomerName ?? "").length > 0);
    assert.equal(issueData.CustomerAddr, vendorRow?.contact_address);
    assert.ok(String(issueData.CustomerAddr ?? "").length > 0);

    const invoices = await vendorSubscriptionInvoicesForOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].vendor_id, ctx.baseVendor.vendorId);
    assert.equal(invoices[0].provider, "ecpay");
    assert.equal(invoices[0].status, "issued");
    assertString(invoices[0].invoice_no, "subscription invoice_no");

    await ctx.fixtures.ensureAdminRole();
    const duplicateResponse = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-invoice",
      {
        subscriptionOrderId: checkout.subscriptionOrderId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const duplicateJson = await expectJson<Record<string, unknown>>(
      duplicateResponse,
      200,
      "idempotent admin vendor subscription invoice",
    );
    assert.equal(duplicateJson.provider, "ecpay");
    assert.equal(duplicateJson.subscriptionOrderId, checkout.subscriptionOrderId);
    assert.equal(duplicateJson.vendorId, ctx.baseVendor.vendorId);
    assert.equal(duplicateJson.status, "issued");
    assert.equal(duplicateJson.skipped, true);
    assert.equal(duplicateJson.invoiceNo, invoices[0].invoice_no);
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);
  },
);

test(
  "haiglobals-ecpay-invoice-print opens an issued vendor subscription invoice",
  ["vendor-subscription", "invoice-print", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 150, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await expectStatus(await postVendorSubscriptionCallback(ctx, checkout), 200);
    // Auto-issued on the paid callback; without a CustomerName this would have
    // failed with 1200021 and there would be nothing to print.
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);
    const invoices = await vendorSubscriptionInvoicesForOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(invoices[0].status, "issued");

    const response = await callJson(
      ctx.handlers,
      "haiglobals-ecpay-invoice-print",
      {
        invoiceTarget: "vendor_subscription",
        vendorId: ctx.baseVendor.vendorId,
        subscriptionOrderId: checkout.subscriptionOrderId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.ok, true);
    assert.equal(json.invoiceTarget, "vendor_subscription");
    assert.equal(json.subscriptionOrderId, checkout.subscriptionOrderId);
    assert.equal(json.invoiceNo, invoices[0].invoice_no);
    assertString(json.invoiceHtml, "vendor subscription invoice print html");
    assert.ok(ctx.ecpay.count("invoicePrint") >= 1);
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return skips auto invoice for a non-Taiwan vendor",
  ["vendor-subscription", "return", "invoice", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 150, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    // Move the vendor outside Taiwan for this run, then restore it so later tests
    // still see a TW vendor.
    await ctx.db.patchRows(
      "vendors",
      { id: `eq.${ctx.baseVendor.vendorId}` },
      { country_code: "JP" },
    );
    try {
      await expectStatus(await postVendorSubscriptionCallback(ctx, checkout), 200);

      // Payment still activates the entitlement...
      const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
      assert.equal(subscription.status, "active");
      // ...but no ECPay invoice is issued for a non-Taiwan vendor.
      assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
      const invoices = await vendorSubscriptionInvoicesForOrder(
        ctx.db,
        checkout.subscriptionOrderId,
      );
      assert.equal(invoices.length, 0);

      // The admin re-issue endpoint reports the same skip instead of issuing.
      await ctx.fixtures.ensureAdminRole();
      const adminResponse = await callJson(
        ctx.handlers,
        "haiglobals-ecpay-vendor-subscription-invoice",
        {
          subscriptionOrderId: checkout.subscriptionOrderId,
        },
        { accessToken: ctx.auth.accessToken },
      );
      const adminJson = await expectJson<Record<string, unknown>>(adminResponse, 200);
      assert.equal(adminJson.skipped, true);
      assert.equal(adminJson.status, "skipped");
      assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
    } finally {
      await ctx.db.patchRows(
        "vendors",
        { id: `eq.${ctx.baseVendor.vendorId}` },
        { country_code: "TW" },
      );
    }
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return is idempotent for duplicate callback",
  ["vendor-subscription", "return", "idempotency"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 130, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(checkout.merchantTradeNo, checkout.amount, {
        TradeNo: "QA-DUPLICATE-TRADE",
        TotalSuccessTimes: "1",
      }),
    );

    await expectStatus(
      await callForm(ctx.handlers, "haiglobals-ecpay-vendor-subscription-return", payload),
      200,
    );
    await expectStatus(
      await callForm(ctx.handlers, "haiglobals-ecpay-vendor-subscription-return", payload),
      200,
    );

    const payments = await ctx.db.selectRows<Record<string, unknown>>(
      "vendor_subscription_payments",
      {
        select: "*",
        subscription_order_id: `eq.${checkout.subscriptionOrderId}`,
      },
    );
    assert.equal(payments.length, 1);
    assert.equal(ctx.ecpay.count("invoiceIssue"), 1);
    assert.equal(
      (await vendorSubscriptionInvoicesForOrder(ctx.db, checkout.subscriptionOrderId)).length,
      1,
    );
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return records simulated callback without activating subscription",
  ["vendor-subscription", "return", "simulated"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 125, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(checkout.merchantTradeNo, checkout.amount, {
        TradeNo: "QA-SIMULATED-TRADE",
        TotalSuccessTimes: "1",
        SimulatePaid: "1",
        RtnMsg: "模擬付款",
      }),
    );

    const response = await callForm(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-return",
      payload,
    );
    await expectStatus(response, 200);

    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(order.payment_status, "pending");
    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "pending");
    const payments = await ctx.db.selectRows<Record<string, unknown>>(
      "vendor_subscription_payments",
      {
        select: "*",
        subscription_order_id: `eq.${checkout.subscriptionOrderId}`,
      },
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, "failed");
    assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
    assert.equal(
      (await vendorSubscriptionInvoicesForOrder(ctx.db, checkout.subscriptionOrderId)).length,
      0,
    );
  },
);

test(
  "haiglobals-ecpay-vendor-subscription-return records failed payment callback",
  ["vendor-subscription", "return", "failure"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 110, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    const payload = await paymentSignedPayload(
      ecpayPaymentSuccessPayload(checkout.merchantTradeNo, checkout.amount, {
        RtnCode: "0",
        RtnMsg: "付款失敗",
        TradeNo: "QA-FAILED-TRADE",
      }),
    );

    const response = await callForm(
      ctx.handlers,
      "haiglobals-ecpay-vendor-subscription-return",
      payload,
    );
    await expectStatus(response, 200);
    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(order.payment_status, "failed");
    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "pending");
    assert.equal(ctx.ecpay.count("invoiceIssue"), 0);
    assert.equal(
      (await vendorSubscriptionInvoicesForOrder(ctx.db, checkout.subscriptionOrderId)).length,
      0,
    );
  },
);

test(
  "haiglobals-vendor-subscription-cancel cancels pending checkout and local subscription",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 99, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.success, true);
    assert.equal(json.status, "cancelled");
    assert.equal(json.cancelledPendingCheckout, true);

    const order = await latestVendorSubscriptionOrder(ctx.db, checkout.subscriptionOrderId);
    assert.equal(order.payment_status, "cancelled");
    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "cancelled");
    // A pending checkout never held entitlement, so cancelling it must not grant
    // one that reaches into the future.
    assert.ok(new Date(String(subscription.current_period_end)).getTime() <= Date.now());
    assert.ok(
      new Date(String(subscription.current_period_end)).getTime() >
        new Date(String(subscription.current_period_start)).getTime(),
    );
  },
);

test(
  "haiglobals-vendor-subscription-cancel cancels active recurring subscription through mocked ECPay",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 210, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await expectStatus(await postVendorSubscriptionCallback(ctx, checkout), 200);

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.success, true);
    assert.equal(json.status, "cancelled");
    assert.ok(ctx.ecpay.count("periodAction") >= 1);

    const subscription = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(subscription.status, "cancelled");
  },
);

test(
  "haiglobals-vendor-subscription-cancel keeps entitlement until period end by default",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 210, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await payVendorSubscriptionNow(ctx, checkout);
    const before = await getSubscription(ctx.db, checkout.subscriptionId);

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.immediate, false);
    assert.equal(json.changedPeriod, false);

    const after = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(after.status, "cancelled");
    assert.equal(
      new Date(String(after.current_period_end)).getTime(),
      new Date(String(before.current_period_end)).getTime(),
    );
    assert.ok(new Date(String(after.current_period_end)).getTime() > Date.now());
  },
);

test(
  "haiglobals-vendor-subscription-cancel with immediate=true expires entitlement now",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 210, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await payVendorSubscriptionNow(ctx, checkout);
    const before = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.ok(new Date(String(before.current_period_end)).getTime() > Date.now());

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
        immediate: true,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.success, true);
    assert.equal(json.immediate, true);
    assert.equal(json.changedPeriod, true);
    assert.ok(ctx.ecpay.count("periodAction") >= 1);

    const after = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(after.status, "cancelled");
    assert.ok(new Date(String(after.current_period_end)).getTime() <= Date.now());

    // Nothing is left to expire, so a repeated immediate cancel is a no-op.
    const repeat = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
        immediate: true,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const repeatJson = await expectJson<Record<string, unknown>>(repeat, 200);
    assert.equal(repeatJson.alreadyCancelled, true);
    assert.equal(repeatJson.changedPeriod, false);
    const repeated = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(
      new Date(String(repeated.current_period_end)).getTime(),
      new Date(String(after.current_period_end)).getTime(),
    );
  },
);

test(
  "haiglobals-vendor-subscription-cancel with immediate=true never extends a lapsed period",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 210, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    // Paid long enough ago that the monthly entitlement period already lapsed.
    const paidAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await expectStatus(
      await postVendorSubscriptionCallback(ctx, checkout, {
        PaymentDate: ecpayTaipeiDateTime(paidAt),
        TradeDate: ecpayTaipeiDateTime(paidAt),
      }),
      200,
    );
    const before = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.ok(new Date(String(before.current_period_end)).getTime() < Date.now());

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
        immediate: true,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.changedPeriod, false);

    const after = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.equal(after.status, "cancelled");
    assert.equal(
      new Date(String(after.current_period_end)).getTime(),
      new Date(String(before.current_period_end)).getTime(),
    );
  },
);

test(
  "haiglobals-vendor-subscription-cancel with immediate=true expires a subscription cancelled at period end",
  ["vendor-subscription", "cancel", "supabase"],
  async (ctx) => {
    ctx.ecpay.reset();
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 210, execTimes: 3 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await payVendorSubscriptionNow(ctx, checkout);
    await expectJson(
      await callJson(
        ctx.handlers,
        "haiglobals-vendor-subscription-cancel",
        {
          vendorId: ctx.baseVendor.vendorId,
          subscriptionId: checkout.subscriptionId,
        },
        { accessToken: ctx.auth.accessToken },
      ),
      200,
    );
    const deferred = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.ok(new Date(String(deferred.current_period_end)).getTime() > Date.now());

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
        immediate: true,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.alreadyCancelled, true);
    assert.equal(json.changedPeriod, true);

    const after = await getSubscription(ctx.db, checkout.subscriptionId);
    assert.ok(new Date(String(after.current_period_end)).getTime() <= Date.now());
    assert.equal(
      new Date(String(after.cancelled_at)).getTime(),
      new Date(String(deferred.cancelled_at)).getTime(),
    );
  },
);

test(
  "haiglobals-vendor-subscription-cancel is idempotent for already-cancelled subscription",
  ["vendor-subscription", "cancel", "idempotency"],
  async (ctx) => {
    const plan = await ctx.fixtures.createSubscriptionPlan({ amount: 100, execTimes: 2 });
    const checkout = await ctx.fixtures.createVendorSubscriptionCheckout(
      ctx.baseVendor.vendorId,
      plan.planCode,
    );
    await expectJson(
      await callJson(
        ctx.handlers,
        "haiglobals-vendor-subscription-cancel",
        {
          vendorId: ctx.baseVendor.vendorId,
          subscriptionId: checkout.subscriptionId,
        },
        { accessToken: ctx.auth.accessToken },
      ),
      200,
    );

    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: checkout.subscriptionId,
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 200);
    assert.equal(json.alreadyCancelled, true);
  },
);

test(
  "haiglobals-vendor-subscription-cancel returns validation error when no cancellable subscription exists",
  ["vendor-subscription", "cancel", "validation"],
  async (ctx) => {
    const response = await callJson(
      ctx.handlers,
      "haiglobals-vendor-subscription-cancel",
      {
        vendorId: ctx.baseVendor.vendorId,
        subscriptionId: randomUUID(),
      },
      { accessToken: ctx.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(response, 400);
    assertIncludes(String(json.error), "No cancellable vendor subscription");
  },
);

async function createHandlerOnlyContext(): Promise<TestContext> {
  const cleanup = new CleanupTracker();
  const ecpay = new EcpayFetchMock();
  ecpay.install();
  const handlers = await loadHandlers();
  return {
    db: {} as SupabaseTestClient,
    cleanup,
    auth: { accessToken: "", userId: "", raw: {} },
    handlers,
    fixtures: {} as TestFixtures,
    ecpay,
    baseVendor: { vendorId: "", email: "" },
    baseProduct: { productId: "", vendorId: "" },
  };
}

async function createContext(): Promise<TestContext> {
  const db = new SupabaseTestClient(requireSupabaseEnv());
  const cleanup = new CleanupTracker();
  const ecpay = new EcpayFetchMock();
  ecpay.install();

  try {
    const credentials = getTestUserCredentials();
    const auth = await db.signInWithPhonePassword(credentials.phone, credentials.password);
    const handlers = await loadHandlers();
    const fixtures = new TestFixtures(db, cleanup, auth, handlers);

    await fixtures.ensureUserProfile();
    const baseVendor = await fixtures.createVendor();
    await fixtures.ensureVendorShippingMethods(baseVendor.vendorId);
    const baseProduct = await fixtures.createProduct(baseVendor.vendorId);

    return { db, cleanup, auth, handlers, fixtures, ecpay, baseVendor, baseProduct };
  } catch (error) {
    try {
      if (cleanupEnabled()) await cleanup.run();
    } catch (cleanupError) {
      console.error("Cleanup failed after context setup error:");
      console.error(
        cleanupError instanceof Error ? (cleanupError.stack ?? cleanupError.message) : cleanupError,
      );
    } finally {
      ecpay.uninstall();
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected = selectedTests(args);

  if (args.list) {
    for (const item of selected) {
      console.log(`${item.name} [${item.tags.join(",")}]`);
    }
    return;
  }

  if (selected.length === 0) {
    throw new Error("No tests selected");
  }

  console.log(`Selected ${selected.length}/${tests.length} API tests`);

  let ctx: TestContext | null = null;
  let cleanupError: unknown = null;
  const failures: Array<{ name: string; error: unknown }> = [];

  try {
    const needsSupabase = selected.some((item) => item.needsSupabase);
    ctx = needsSupabase ? await createContext() : await createHandlerOnlyContext();
    if (needsSupabase) {
      console.log(
        `Signed in test user ${ctx.auth.userId}; created isolated vendor/product fixtures for run ${ctx.fixtures.runId}`,
      );
    } else {
      console.log("Running handler-only tests; Supabase setup skipped.");
    }

    for (const item of selected) {
      const startedAt = Date.now();
      try {
        await item.fn(ctx);
        console.log(`✓ ${item.name} (${Date.now() - startedAt} ms)`);
      } catch (error) {
        failures.push({ name: item.name, error });
        console.error(`✗ ${item.name} (${Date.now() - startedAt} ms)`);
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      }
    }
  } finally {
    if (ctx) {
      try {
        if (cleanupEnabled()) {
          console.log(`Running cleanup (${ctx.cleanup.size} tracked cleanup tasks)...`);
          await ctx.cleanup.run();
        } else {
          console.warn("TEST_CLEANUP=false, leaving test-created data in Supabase for debugging.");
        }
      } catch (error) {
        cleanupError = error;
        console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      } finally {
        ctx.ecpay.uninstall();
      }
    }
  }

  if (cleanupError) {
    failures.push({ name: "cleanup", error: cleanupError });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} test(s) failed:`);
    for (const failure of failures) {
      console.error(
        `- ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nAll ${selected.length} selected API tests passed.`);
}

await main();
