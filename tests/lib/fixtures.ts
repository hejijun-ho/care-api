import { randomUUID } from "node:crypto";
import { expectJson } from "./assertions.ts";
import { callJson, type HandlerMap } from "./function-client.ts";
import { CleanupTracker, SupabaseTestClient, type AuthSession } from "./supabase.ts";

type CreatedVendor = {
  vendorId: string;
  email: string;
};

type CreatedProduct = {
  productId: string;
  vendorId: string;
};

type CreatedOrder = {
  orderId: string;
  orderNumber?: string;
  amount: number;
};

type CreatedSubscriptionPlan = {
  planCode: string;
  featureCode: string;
};

type CreatedSubscriptionCheckout = {
  vendorId: string;
  planCode: string;
  subscriptionId: string;
  subscriptionOrderId: string;
  merchantTradeNo: string;
  amount: number;
  fields: Record<string, string>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
}

function safeProductNameRunId(runId: string): string {
  return runId
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addText(target: Set<string>, value: unknown): void {
  const text = String(value ?? "").trim();
  if (text) target.add(text);
}

function addColumnValues(
  rows: Array<Record<string, unknown>>,
  column: string,
  target: Set<string>,
): void {
  for (const row of rows) addText(target, row[column]);
}

export class TestFixtures {
  private adminRoleRestoreValue: string | null | undefined;
  private createdUserProfile = false;
  private readonly exchangeRateIds = new Set<string>();
  private readonly featureCodes = new Set<string>();
  private readonly orderIds = new Set<string>();
  private readonly planCodes = new Set<string>();
  private readonly platformShippingMethodIds = new Set<string>();
  private readonly productIds = new Set<string>();
  private readonly subscriptionIds = new Set<string>();
  private readonly subscriptionOrderIds = new Set<string>();
  private readonly vendorIds = new Set<string>();

  readonly runId = `qa_${safeRunId(Date.now().toString(36))}_${shortId()}`;

  constructor(
    readonly db: SupabaseTestClient,
    readonly cleanup: CleanupTracker,
    readonly auth: AuthSession,
    readonly handlers: HandlerMap,
  ) {
    this.cleanup.defer(`sweep test-created data for ${this.runId}`, async () => {
      await this.sweepCreatedData();
    });
  }

  registerPlatformShippingMethodCleanup(shippingMethodId: string): void {
    addText(this.platformShippingMethodIds, shippingMethodId);
    this.cleanup.defer(`delete platform_shipping_method ${shippingMethodId}`, async () => {
      await this.db.deleteRows("platform_shipping_methods", { id: `eq.${shippingMethodId}` });
    });
  }

  registerVendorShippingMethodCleanup(vendorId: string, shippingMethodId: string): void {
    this.cleanup.defer(
      `delete vendor_shipping_method ${vendorId}/${shippingMethodId}`,
      async () => {
        await this.db.deleteRows("vendor_shipping_methods", {
          vendor_id: `eq.${vendorId}`,
          shipping_method_id: `eq.${shippingMethodId}`,
        });
      },
    );
  }

  private async deleteRowsForValues(
    table: string,
    column: string,
    values: Iterable<string>,
  ): Promise<void> {
    for (const value of values) {
      await this.db.deleteRows(table, { [column]: `eq.${value}` });
    }
  }

  private async collectTestRootIds(): Promise<{
    featureCodes: Set<string>;
    orderIds: Set<string>;
    planCodes: Set<string>;
    platformShippingMethodIds: Set<string>;
    productIds: Set<string>;
    subscriptionIds: Set<string>;
    subscriptionOrderIds: Set<string>;
    vendorIds: Set<string>;
  }> {
    const featureCodes = new Set(this.featureCodes);
    const orderIds = new Set(this.orderIds);
    const planCodes = new Set(this.planCodes);
    const platformShippingMethodIds = new Set(this.platformShippingMethodIds);
    const productIds = new Set(this.productIds);
    const subscriptionIds = new Set(this.subscriptionIds);
    const subscriptionOrderIds = new Set(this.subscriptionOrderIds);
    const vendorIds = new Set(this.vendorIds);

    addColumnValues(
      await this.db.selectRows<Record<string, unknown>>("vendors", {
        select: "id",
        contact_email: `eq.vendor+${this.runId}@example.test`,
      }),
      "id",
      vendorIds,
    );

    addColumnValues(
      await this.db.selectRows<Record<string, unknown>>("vendor_subscription_plans", {
        select: "code",
        code: `like.qa_${safeRunId(this.runId).toLowerCase()}_*`,
      }),
      "code",
      planCodes,
    );

    addColumnValues(
      await this.db.selectRows<Record<string, unknown>>("platform_shipping_methods", {
        select: "id",
        code: `like.qa_${this.runId}_*`,
      }),
      "id",
      platformShippingMethodIds,
    );

    for (const vendorId of vendorIds) {
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("products", {
          select: "id",
          vendor_id: `eq.${vendorId}`,
        }),
        "id",
        productIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("order_items", {
          select: "order_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "order_id",
        orderIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("order_shipments", {
          select: "order_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "order_id",
        orderIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscriptions", {
          select: "id",
          vendor_id: `eq.${vendorId}`,
        }),
        "id",
        subscriptionIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_orders", {
          select: "id,subscription_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "id",
        subscriptionOrderIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_orders", {
          select: "subscription_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "subscription_id",
        subscriptionIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_payments", {
          select: "subscription_order_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "subscription_order_id",
        subscriptionOrderIds,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_invoices", {
          select: "subscription_order_id",
          vendor_id: `eq.${vendorId}`,
        }),
        "subscription_order_id",
        subscriptionOrderIds,
      );
    }

    for (const productId of productIds) {
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("order_items", {
          select: "order_id",
          product_id: `eq.${productId}`,
        }),
        "order_id",
        orderIds,
      );
    }

    for (const planCode of planCodes) {
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_plan_features", {
          select: "feature_code",
          plan_code: `eq.${planCode}`,
        }),
        "feature_code",
        featureCodes,
      );
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscriptions", {
          select: "id",
          plan_code: `eq.${planCode}`,
        }),
        "id",
        subscriptionIds,
      );
    }

    for (const subscriptionId of subscriptionIds) {
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_orders", {
          select: "id",
          subscription_id: `eq.${subscriptionId}`,
        }),
        "id",
        subscriptionOrderIds,
      );
    }

    for (const subscriptionOrderId of subscriptionOrderIds) {
      addColumnValues(
        await this.db.selectRows<Record<string, unknown>>("vendor_subscription_orders", {
          select: "subscription_id",
          id: `eq.${subscriptionOrderId}`,
        }),
        "subscription_id",
        subscriptionIds,
      );
    }

    return {
      featureCodes,
      orderIds,
      planCodes,
      platformShippingMethodIds,
      productIds,
      subscriptionIds,
      subscriptionOrderIds,
      vendorIds,
    };
  }

  private async sweepCreatedData(): Promise<void> {
    const ids = await this.collectTestRootIds();

    await this.deleteRowsForValues("order_refunds", "order_id", ids.orderIds);
    await this.deleteRowsForValues("order_invoices", "order_id", ids.orderIds);
    await this.deleteRowsForValues("order_shipments", "order_id", ids.orderIds);
    await this.deleteRowsForValues("order_items", "order_id", ids.orderIds);
    await this.deleteRowsForValues("orders", "id", ids.orderIds);

    await this.deleteRowsForValues(
      "vendor_subscription_invoices",
      "subscription_order_id",
      ids.subscriptionOrderIds,
    );
    await this.deleteRowsForValues(
      "vendor_subscription_payments",
      "subscription_order_id",
      ids.subscriptionOrderIds,
    );
    await this.deleteRowsForValues("vendor_subscription_orders", "id", ids.subscriptionOrderIds);
    await this.deleteRowsForValues("vendor_subscriptions", "id", ids.subscriptionIds);

    await this.deleteRowsForValues("vendor_subscription_plan_features", "plan_code", ids.planCodes);
    await this.deleteRowsForValues("vendor_subscription_plans", "code", ids.planCodes);
    await this.deleteRowsForValues("vendor_subscription_features", "code", ids.featureCodes);

    await this.deleteRowsForValues("exchange_rates", "id", this.exchangeRateIds);
    await this.deleteRowsForValues("vendor_shipping_methods", "vendor_id", ids.vendorIds);
    await this.deleteRowsForValues("products", "id", ids.productIds);
    await this.deleteRowsForValues(
      "platform_shipping_methods",
      "id",
      ids.platformShippingMethodIds,
    );
    await this.deleteRowsForValues("vendors", "id", ids.vendorIds);

    if (this.createdUserProfile) {
      await this.db.deleteRows("users", { id: `eq.${this.auth.userId}` });
    }
  }

  async ensureAdminRole(): Promise<void> {
    const existing = await this.db.selectOne<Record<string, unknown>>("users", {
      select: "id,role",
      id: `eq.${this.auth.userId}`,
    });
    const currentRole = String(existing?.role ?? "").trim();
    if (currentRole === "admin") return;

    if (this.adminRoleRestoreValue === undefined) {
      this.adminRoleRestoreValue = currentRole || "user";
      this.cleanup.defer("restore test user role", async () => {
        await this.db.patchRows(
          "users",
          { id: `eq.${this.auth.userId}` },
          {
            role: this.adminRoleRestoreValue || "user",
            updated_at: nowIso(),
          },
        );
      });
    }

    await this.db.patchRows(
      "users",
      { id: `eq.${this.auth.userId}` },
      {
        role: "admin",
        updated_at: nowIso(),
      },
    );
  }

  async ensureUserProfile(): Promise<void> {
    const qaEmail = `qa+${this.runId}@example.test`;
    const existing = await this.db.selectOne<Record<string, unknown>>("users", {
      select: "id,email,phone",
      id: `eq.${this.auth.userId}`,
    });

    if (existing) {
      // Some staging databases have the auth user but an incomplete public user profile.
      // Subscription invoice tests need users.email, so patch it only when missing and
      // restore the previous value in cleanup to keep every Supabase mutation reversible.
      const existingEmail = String(existing.email ?? "").trim();
      if (!existingEmail) {
        const previousEmail = existing.email ?? null;
        await this.db.patchRows(
          "users",
          { id: `eq.${this.auth.userId}` },
          {
            email: qaEmail,
            updated_at: nowIso(),
          },
        );
        this.cleanup.defer("restore test user profile email", async () => {
          await this.db.patchRows(
            "users",
            { id: `eq.${this.auth.userId}` },
            {
              email: previousEmail,
              updated_at: nowIso(),
            },
          );
        });
      }
      return;
    }

    await this.db.insertOne(
      "users",
      {
        id: this.auth.userId,
        email: qaEmail,
        phone: process.env.TEST_USER_PHONE,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      { adaptive: false },
    );
    this.createdUserProfile = true;
    this.cleanup.defer("delete test-created users profile", async () => {
      await this.db.deleteRows("users", { id: `eq.${this.auth.userId}` });
    });
  }

  async createVendor(): Promise<CreatedVendor> {
    const vendorId = randomUUID();
    addText(this.vendorIds, vendorId);
    const email = `vendor+${this.runId}@example.test`;
    const row = await this.db.insertOne<Record<string, unknown>>(
      "vendors",
      {
        id: vendorId,
        user_id: this.auth.userId,
        company_name: `QA Vendor ${this.runId}`,
        store_name: `QA Vendor ${this.runId}`,
        contact_email: email,
        status: "active",
        mobile_phone: process.env.TEST_USER_PHONE,
        contact_name: "QA Vendor",
        contact_phone: process.env.TEST_USER_PHONE,
        contact_address: "台北市信義區信義路五段7號",
        legal_type: "individual",
        vendor_role: "vendor",
        onboarding_status: "approved",
        document_status: "approved",
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      { adaptive: false },
    );

    const resolvedVendorId = String(row.id ?? vendorId).trim();
    if (!resolvedVendorId) throw new Error("Created vendor did not resolve an id");
    addText(this.vendorIds, resolvedVendorId);

    this.cleanup.defer(`delete vendor ${resolvedVendorId}`, async () => {
      await this.db.deleteRows("vendors", { id: `eq.${resolvedVendorId}` });
    });

    return { vendorId: resolvedVendorId, email };
  }

  async ensureVendorShippingMethods(vendorId: string): Promise<void> {
    const definitions = [
      {
        code: `qa_${this.runId}_unimart`,
        name: "QA UNIMART C2C",
        provider: "ecpay",
        logistics_type: "CVS",
        logistics_sub_type: "UNIMARTC2C",
      },
      {
        code: `qa_${this.runId}_manual`,
        name: "QA Manual Home",
        provider: "manual",
        logistics_type: "HOME",
        logistics_sub_type: "MANUAL",
      },
    ];

    for (const definition of definitions) {
      let method = await this.db.selectOne<Record<string, unknown>>("platform_shipping_methods", {
        select: "id",
        provider: `eq.${definition.provider}`,
        logistics_type: `eq.${definition.logistics_type}`,
        logistics_sub_type: `eq.${definition.logistics_sub_type}`,
        enabled: "eq.true",
      });
      let createdMethod = false;
      if (!method?.id) {
        const methodId = randomUUID();
        method = await this.db.insertOne<Record<string, unknown>>(
          "platform_shipping_methods",
          {
            id: methodId,
            code: definition.code,
            name: definition.name,
            provider: definition.provider,
            logistics_type: definition.logistics_type,
            logistics_sub_type: definition.logistics_sub_type,
            shipping_fee: 0,
            is_collection_supported: true,
            enabled: true,
            sort_order: 999,
            created_at: nowIso(),
            updated_at: nowIso(),
          },
          { adaptive: false },
        );
        createdMethod = true;
      }

      const shippingMethodId = String(method.id ?? "").trim();
      if (!shippingMethodId) throw new Error("Shipping method id is missing");
      const existingVendorMethod = await this.db.selectOne<Record<string, unknown>>(
        "vendor_shipping_methods",
        {
          select: "vendor_id,shipping_method_id",
          vendor_id: `eq.${vendorId}`,
          shipping_method_id: `eq.${shippingMethodId}`,
        },
      );
      if (!existingVendorMethod) {
        await this.db.insertOne(
          "vendor_shipping_methods",
          {
            vendor_id: vendorId,
            shipping_method_id: shippingMethodId,
            created_at: nowIso(),
          },
          { adaptive: false },
        );
        this.registerVendorShippingMethodCleanup(vendorId, shippingMethodId);
      }
      if (createdMethod) {
        this.registerPlatformShippingMethodCleanup(shippingMethodId);
      }
    }
  }

  async createExchangeRate(options: {
    toCurrency: string;
    rate: number;
    fromCurrency?: string;
    source?: string;
    createdAt?: string;
  }): Promise<string> {
    const exchangeRateId = randomUUID();
    const row = await this.db.insertOne<Record<string, unknown>>(
      "exchange_rates",
      {
        id: exchangeRateId,
        source: options.source ?? "openexchangerates",
        from_currency: options.fromCurrency ?? "TWD",
        to_currency: options.toCurrency,
        rate: options.rate,
        created_at: options.createdAt ?? nowIso(),
      },
      { adaptive: false },
    );

    const resolvedId = String(row.id ?? exchangeRateId).trim() || exchangeRateId;
    addText(this.exchangeRateIds, resolvedId);
    this.cleanup.defer(`delete exchange_rate ${resolvedId}`, async () => {
      await this.db.deleteRows("exchange_rates", { id: `eq.${resolvedId}` });
    });
    return resolvedId;
  }

  async createProduct(
    vendorId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CreatedProduct> {
    const productId = randomUUID();
    addText(this.productIds, productId);
    const sanitizedOverrides = { ...overrides };
    // products.price and products.is_active are generated/read-only columns.
    // Seed base_price/special_price and the underlying visibility inputs instead.
    if ("price" in sanitizedOverrides && !("base_price" in sanitizedOverrides)) {
      sanitizedOverrides.base_price = sanitizedOverrides.price;
    }
    delete sanitizedOverrides.price;
    delete sanitizedOverrides.is_active;
    delete sanitizedOverrides.status;
    delete sanitizedOverrides.review_status;

    const row = await this.db.insertOne<Record<string, unknown>>(
      "products",
      {
        id: productId,
        vendor_id: vendorId,
        name: `QA Product ${safeProductNameRunId(this.runId)}`,
        base_price: 120,
        special_price: null,
        stock: 50,
        image_url: "https://example.test/qa-product.png",
        published: true,
        review_status: "approved",
        created_at: nowIso(),
        updated_at: nowIso(),
        ...sanitizedOverrides,
      },
      { adaptive: false },
    );

    const resolvedProductId = String(row.id ?? productId).trim();
    if (!resolvedProductId) throw new Error("Created product did not resolve an id");
    addText(this.productIds, resolvedProductId);

    this.cleanup.defer(`delete product ${resolvedProductId}`, async () => {
      await this.db.deleteRows("products", { id: `eq.${resolvedProductId}` });
    });

    return { productId: resolvedProductId, vendorId };
  }

  registerOrderCleanup(orderId: string): void {
    addText(this.orderIds, orderId);
    this.cleanup.defer(`delete order ${orderId}`, async () => {
      await this.db.deleteRows("orders", { id: `eq.${orderId}` });
    });
    this.cleanup.defer(`delete order_items for ${orderId}`, async () => {
      await this.db.deleteRows("order_items", { order_id: `eq.${orderId}` });
    });
    this.cleanup.defer(`delete order_shipments for ${orderId}`, async () => {
      await this.db.deleteRows("order_shipments", { order_id: `eq.${orderId}` });
    });
    this.cleanup.defer(`delete order_invoices for ${orderId}`, async () => {
      await this.db.deleteRows("order_invoices", { order_id: `eq.${orderId}` });
    });
    this.cleanup.defer(`delete order_refunds for ${orderId}`, async () => {
      await this.db.deleteRows("order_refunds", { order_id: `eq.${orderId}` });
    });
  }

  async createOrderViaCheckout(options: {
    productId: string;
    skuId?: string;
    paymentMethod?: "credit" | "atm" | "cod";
    deliveryMethod?: "cvs" | "home_delivery";
    logisticsSubType?: string;
    quantity?: number;
    amount?: number;
    clientBackUrl?: string;
    recipientPhone?: string;
  }): Promise<CreatedOrder> {
    const paymentMethod = options.paymentMethod ?? "credit";
    const deliveryMethod = options.deliveryMethod ?? "cvs";
    const isCvs = deliveryMethod === "cvs";
    const body = {
      checkoutDraft: {
        paymentProvider: "ecpay",
        paymentMethod,
        deliveryMethod,
        logisticsSubType: options.logisticsSubType ?? (isCvs ? "UNIMARTC2C" : "MANUAL"),
        recipientName: "測試收件人",
        recipientPhone: options.recipientPhone ?? "0912345678",
        recipientAddress: isCvs ? "" : "台北市中正區測試路 1 號",
        recipientCountryCode: "TW",
        recipientZipcode: "100",
        pickupStoreName: isCvs ? "測試門市" : "",
        pickupStoreCode: isCvs ? "991182" : "",
        pickupStoreAddress: isCvs ? "台北市測試門市地址" : "",
        invoiceType: "personal",
        items: [
          {
            productId: options.productId,
            skuId: options.skuId,
            quantity: options.quantity ?? 1,
          },
        ],
      },
      amount: options.amount,
      clientBackUrl: options.clientBackUrl ?? "https://frontend.test/#/orders",
    };

    const response = await callJson(this.handlers, "haiglobals-ecpay-checkout", body, {
      accessToken: this.auth.accessToken,
    });
    const json = await expectJson<Record<string, unknown>>(response, 200, "createOrderViaCheckout");
    const orderId = String(json.orderId ?? "").trim();
    if (!orderId)
      throw new Error(`Checkout response did not include orderId: ${JSON.stringify(json)}`);
    this.registerOrderCleanup(orderId);

    return {
      orderId,
      orderNumber: String(json.orderNumber ?? "") || undefined,
      amount: Number(json.amount ?? 0),
    };
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    const order = await this.db.selectOne<Record<string, unknown>>("orders", {
      select: "*",
      id: `eq.${orderId}`,
    });
    if (!order) throw new Error(`Order not found: ${orderId}`);
    return order;
  }

  async patchOrder(orderId: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.patchRows("orders", { id: `eq.${orderId}` }, payload);
  }

  async getShipmentByOrder(orderId: string, vendorId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { select: "*", order_id: `eq.${orderId}` };
    if (vendorId) params.vendor_id = `eq.${vendorId}`;
    const shipment = await this.db.selectOne<Record<string, unknown>>("order_shipments", params);
    if (!shipment) throw new Error(`Shipment not found for order: ${orderId}`);
    return shipment;
  }

  async patchShipment(shipmentId: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.patchRows("order_shipments", { id: `eq.${shipmentId}` }, payload);
  }

  async getInvoice(orderId: string): Promise<Record<string, unknown> | null> {
    return await this.db.selectOne<Record<string, unknown>>("order_invoices", {
      select: "*",
      order_id: `eq.${orderId}`,
    });
  }

  async patchInvoice(orderId: string, payload: Record<string, unknown>): Promise<void> {
    const invoice = await this.getInvoice(orderId);
    if (invoice?.id) {
      await this.db.patchRows("order_invoices", { id: `eq.${String(invoice.id)}` }, payload);
      return;
    }
    await this.db.insertOne("order_invoices", {
      order_id: orderId,
      ...payload,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  async createSubscriptionPlan(
    options: {
      amount?: number;
      currency?: string;
      periodType?: "D" | "M" | "Y";
      frequency?: number;
      execTimes?: number;
    } = {},
  ): Promise<CreatedSubscriptionPlan> {
    const suffix = shortId();
    const planCode = `qa_${safeRunId(this.runId).toLowerCase()}_${suffix}`.slice(0, 60);
    const featureCode = `qa_feature_${suffix}`.slice(0, 60);
    addText(this.planCodes, planCode);
    addText(this.featureCodes, featureCode);

    await this.db.insertOne(
      "vendor_subscription_features",
      {
        code: featureCode,
        name: `QA Feature ${suffix}`,
        description: "Created by API integration tests",
        is_active: true,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      { adaptive: false },
    );
    this.cleanup.defer(`delete vendor_subscription_feature ${featureCode}`, async () => {
      await this.db.deleteRows("vendor_subscription_features", { code: `eq.${featureCode}` });
    });

    await this.db.insertOne(
      "vendor_subscription_plans",
      {
        code: planCode,
        name: `QA Plan ${suffix}`,
        description: "Created by API integration tests",
        contract_id: null,
        amount: options.amount ?? 99,
        currency: options.currency ?? "TWD",
        period_type: options.periodType ?? "M",
        frequency: options.frequency ?? 1,
        exec_times: options.execTimes ?? 2,
        is_active: true,
        specified_vendor_role: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
      { adaptive: false },
    );
    this.cleanup.defer(`delete vendor_subscription_plan ${planCode}`, async () => {
      await this.db.deleteRows("vendor_subscription_plans", { code: `eq.${planCode}` });
    });

    await this.db.insertOne(
      "vendor_subscription_plan_features",
      {
        plan_code: planCode,
        feature_code: featureCode,
        created_at: nowIso(),
      },
      { adaptive: false },
    );
    this.cleanup.defer(
      `delete vendor_subscription_plan_feature ${planCode}/${featureCode}`,
      async () => {
        await this.db.deleteRows("vendor_subscription_plan_features", {
          plan_code: `eq.${planCode}`,
          feature_code: `eq.${featureCode}`,
        });
      },
    );

    return { planCode, featureCode };
  }

  registerSubscriptionCleanup(subscriptionOrderId: string, subscriptionId: string): void {
    addText(this.subscriptionOrderIds, subscriptionOrderId);
    addText(this.subscriptionIds, subscriptionId);
    this.cleanup.defer(`delete vendor_subscription ${subscriptionId}`, async () => {
      await this.db.deleteRows("vendor_subscriptions", { id: `eq.${subscriptionId}` });
    });
    this.cleanup.defer(`delete vendor_subscription_order ${subscriptionOrderId}`, async () => {
      await this.db.deleteRows("vendor_subscription_orders", { id: `eq.${subscriptionOrderId}` });
    });
    this.cleanup.defer(
      `delete vendor_subscription_payments for ${subscriptionOrderId}`,
      async () => {
        await this.db.deleteRows("vendor_subscription_payments", {
          subscription_order_id: `eq.${subscriptionOrderId}`,
        });
      },
    );
    this.cleanup.defer(
      `delete vendor_subscription_invoices for ${subscriptionOrderId}`,
      async () => {
        await this.db.deleteRows("vendor_subscription_invoices", {
          subscription_order_id: `eq.${subscriptionOrderId}`,
        });
      },
    );
  }

  async createVendorSubscriptionCheckout(
    vendorId: string,
    planCode: string,
    clientBackUrl = "https://frontend.test/#/vendor/subscription",
  ): Promise<CreatedSubscriptionCheckout> {
    const response = await callJson(
      this.handlers,
      "haiglobals-ecpay-vendor-subscription-checkout",
      { vendorId, planCode, clientBackUrl },
      { accessToken: this.auth.accessToken },
    );
    const json = await expectJson<Record<string, unknown>>(
      response,
      200,
      "createVendorSubscriptionCheckout",
    );
    const subscriptionId = String(json.subscriptionId ?? "").trim();
    const subscriptionOrderId = String(json.subscriptionOrderId ?? "").trim();
    const merchantTradeNo = String(json.merchantTradeNo ?? "").trim();
    if (!subscriptionId || !subscriptionOrderId || !merchantTradeNo) {
      throw new Error(
        `Vendor subscription checkout response is missing ids: ${JSON.stringify(json)}`,
      );
    }
    this.registerSubscriptionCleanup(subscriptionOrderId, subscriptionId);

    return {
      vendorId,
      planCode,
      subscriptionId,
      subscriptionOrderId,
      merchantTradeNo,
      amount: Number(json.amount ?? 0),
      fields:
        json.fields && typeof json.fields === "object"
          ? (json.fields as Record<string, string>)
          : {},
    };
  }
}
