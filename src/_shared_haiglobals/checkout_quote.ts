import { selectRows, type AdminClient } from "./orders.ts";
import {
  convertAmountToTwd,
  fetchLatestExchangeRates,
  normalizeCurrencyCode,
  type CurrencyExchangeOptions,
} from "./currency_exchange.ts";

export type CheckoutQuoteOptions = CurrencyExchangeOptions & {
  dbSchema?: string;
  productsTable?: string;
  skuTable?: string;
  platformShippingMethodsTable?: string;
  vendorShippingMethodsTable?: string;
  vendorsTable?: string;
};

type QuoteItemInput = {
  productId?: string | null;
  product_id?: string | null;
  id?: string | null;
  skuId?: string | null;
  sku_id?: string | null;
  quantity?: number | string | null;
};

type QuoteShippingSelectionInput = {
  vendorId?: string | null;
  vendor_id?: string | null;
  shippingMethodId?: string | null;
  shipping_method_id?: string | null;
};

type QuoteInput = {
  items?: QuoteItemInput[];
  shippingSelections?:
    QuoteShippingSelectionInput[] | Record<string, QuoteShippingSelectionInput | string>;
  shipping_selections?:
    QuoteShippingSelectionInput[] | Record<string, QuoteShippingSelectionInput | string>;
};

type RawQuoteBody = QuoteInput & {
  checkoutDraft?: QuoteInput | null;
  checkout_draft?: QuoteInput | null;
};

type ProductRow = {
  id: string;
  vendor_id?: string | null;
  currency?: string | null;
  price?: number | string | null;
  base_price?: number | string | null;
  stock?: number | string | null;
  stock_owner_product_id?: string | null;
  is_active?: boolean | string | null;
};

type SkuRow = {
  id: string;
  product_id: string;
  price?: number | string | null;
  base_price?: number | string | null;
  stock?: number | string | null;
  stock_owner_sku_id?: string | null;
  is_active?: boolean | string | null;
};

type VendorShippingMethodRow = {
  vendor_id?: string | null;
  shipping_method_id?: string | null;
  shipping_fee_override?: number | string | null;
};

type VendorRow = {
  id: string;
  root_vendor_id?: string | null;
};

type PlatformShippingMethodRow = {
  id: string;
  shipping_fee?: number | string | null;
};

type NormalizedItem = {
  productId: string;
  skuId: string | null;
  quantity: number;
};

type ValidatedItem = {
  productId: string;
  skuId: string | null;
  vendorId: string;
  quantity: number;
  sourceCurrency: string;
  sourceUnitPrice: number;
};

type QuotedItem = {
  productId: string;
  skuId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

type VendorQuote = {
  vendorId: string;
  shippingMethodId: string;
  itemsSubtotal: number;
  shippingFee: number;
  totalAmount: number;
  items: QuotedItem[];
};

export type CheckoutPriceQuote = {
  ok: true;
  currency: "TWD";
  itemsSubtotal: number;
  shippingFee: number;
  totalAmount: number;
  vendors: VendorQuote[];
};

const defaults: Required<CheckoutQuoteOptions> = {
  dbSchema: "haiglobals",
  productsTable: "products",
  skuTable: "sku",
  exchangeRatesTable: "exchange_rates",
  platformShippingMethodsTable: "platform_shipping_methods",
  vendorShippingMethodsTable: "vendor_shipping_methods",
  vendorsTable: "vendors",
  exchangeRateSource: "openexchangerates",
  exchangeRateBaseCurrency: "TWD",
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function inFilter(values: string[]): string {
  return "in.(" + unique(values).join(",") + ")";
}

function money(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function positiveInt(value: unknown, field: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(
          String(value ?? "")
            .replaceAll(",", "")
            .trim(),
          10,
        );
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(field + " must be a positive integer");
  }
  return parsed;
}

function isFalse(value: unknown): boolean {
  return (
    String(value ?? "true")
      .trim()
      .toLowerCase() === "false"
  );
}

function unwrapQuoteInput(rawInput: unknown): QuoteInput {
  if (!rawInput || typeof rawInput !== "object") return {};
  const body = rawInput as RawQuoteBody;
  const draft = body.checkoutDraft ?? body.checkout_draft;
  return draft && typeof draft === "object" ? draft : body;
}

function normalizeItems(input: QuoteInput): NormalizedItem[] {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("checkoutDraft.items must be a non-empty array");
  }

  return input.items.map((item, index) => {
    const productId = text(item.productId ?? item.product_id ?? item.id);
    if (!productId) throw new Error(`items[${index}].productId is required`);

    return {
      productId,
      skuId: text(item.skuId ?? item.sku_id) || null,
      quantity: positiveInt(item.quantity ?? 1, `items[${index}].quantity`),
    };
  });
}

function normalizeShippingSelections(input: QuoteInput): Map<string, string> {
  const raw = input.shippingSelections ?? input.shipping_selections;
  const selections = new Map<string, string>();
  if (!raw) return selections;

  const entries: Array<readonly [string, QuoteShippingSelectionInput | string]> = Array.isArray(raw)
    ? raw.map((item) => ["", item] as const)
    : Object.entries(raw);

  for (const [fallbackVendorId, value] of entries) {
    const vendorId =
      typeof value === "string"
        ? text(fallbackVendorId)
        : text(value.vendorId ?? value.vendor_id) || text(fallbackVendorId);
    const shippingMethodId =
      typeof value === "string"
        ? text(value)
        : text(value.shippingMethodId ?? value.shipping_method_id);

    if (!vendorId) throw new Error("shippingSelections.vendorId is required");
    if (!shippingMethodId) {
      throw new Error("shippingSelections.shippingMethodId is required");
    }
    if (selections.has(vendorId)) {
      throw new Error("Duplicate shipping selection for vendor " + vendorId);
    }
    selections.set(vendorId, shippingMethodId);
  }

  return selections;
}

function assertShippingSelectionsCoverVendors(
  vendorIds: string[],
  selections: Map<string, string>,
): void {
  if (selections.size === 0) {
    throw new Error("shippingSelections is required");
  }

  const vendorIdSet = new Set(vendorIds);

  for (const vendorId of vendorIds) {
    if (!selections.has(vendorId)) {
      throw new Error("Missing shipping selection for vendor " + vendorId);
    }
  }

  for (const vendorId of selections.keys()) {
    if (!vendorIdSet.has(vendorId)) {
      throw new Error("shipping selection vendor has no items: " + vendorId);
    }
  }
}

async function fetchProducts(
  admin: AdminClient,
  table: string,
  productIds: string[],
): Promise<Map<string, ProductRow>> {
  if (productIds.length === 0) return new Map();
  const rows = await selectRows<ProductRow>(admin, table, {
    select: "id,vendor_id,currency,price,base_price,stock,stock_owner_product_id,is_active",
    id: inFilter(productIds),
  });
  return new Map(rows.map((row) => [text(row.id), row]));
}

async function fetchSkus(
  admin: AdminClient,
  table: string,
  skuIds: string[],
): Promise<Map<string, SkuRow>> {
  if (skuIds.length === 0) return new Map();
  const rows = await selectRows<SkuRow>(admin, table, {
    select: "id,product_id,price,base_price,stock,stock_owner_sku_id,is_active",
    id: inFilter(skuIds),
  });
  return new Map(rows.map((row) => [text(row.id), row]));
}

async function addMissingProductStockOwners(
  admin: AdminClient,
  table: string,
  products: Map<string, ProductRow>,
): Promise<void> {
  const ownerIds = unique(
    Array.from(products.values()).map((product) => text(product.stock_owner_product_id)),
  ).filter((ownerId) => !products.has(ownerId));
  if (ownerIds.length === 0) return;

  const owners = await fetchProducts(admin, table, ownerIds);
  for (const [id, owner] of owners) products.set(id, owner);
}

async function addMissingSkuStockOwners(
  admin: AdminClient,
  table: string,
  skus: Map<string, SkuRow>,
): Promise<void> {
  const ownerIds = unique(
    Array.from(skus.values()).map((sku) => text(sku.stock_owner_sku_id)),
  ).filter((ownerId) => !skus.has(ownerId));
  if (ownerIds.length === 0) return;

  const owners = await fetchSkus(admin, table, ownerIds);
  for (const [id, owner] of owners) skus.set(id, owner);
}

function resolveProductStock(product: ProductRow, products: Map<string, ProductRow>): number {
  const ownerId = text(product.stock_owner_product_id) || text(product.id);
  const owner = products.get(ownerId);
  if (!owner) {
    throw new Error(`Stock owner product not found: ${ownerId}`);
  }
  return Number(owner.stock ?? 999999);
}

function resolveSkuStock(sku: SkuRow, skus: Map<string, SkuRow>): number {
  const ownerId = text(sku.stock_owner_sku_id) || text(sku.id);
  const owner = skus.get(ownerId);
  if (!owner) {
    throw new Error(`Stock owner sku not found: ${ownerId}`);
  }
  return Number(owner.stock ?? 999999);
}

async function fetchVendorMethods(
  admin: AdminClient,
  table: string,
  vendorIds: string[],
): Promise<VendorShippingMethodRow[]> {
  if (vendorIds.length === 0) return [];
  return await selectRows<VendorShippingMethodRow>(admin, table, {
    select: "vendor_id,shipping_method_id,shipping_fee_override",
    vendor_id: inFilter(vendorIds),
  });
}

async function fetchVendors(
  admin: AdminClient,
  table: string,
  vendorIds: string[],
): Promise<Map<string, VendorRow>> {
  if (vendorIds.length === 0) return new Map();
  const rows = await selectRows<VendorRow>(admin, table, {
    select: "id,root_vendor_id",
    id: inFilter(vendorIds),
  });
  return new Map(rows.map((row) => [text(row.id), row]));
}

function resolveShippingVendorId(vendorId: string, vendors: Map<string, VendorRow>): string {
  return text(vendors.get(vendorId)?.root_vendor_id) || vendorId;
}

async function fetchPlatformMethods(
  admin: AdminClient,
  table: string,
  methodIds: string[],
): Promise<Map<string, PlatformShippingMethodRow>> {
  if (methodIds.length === 0) return new Map();
  const rows = await selectRows<PlatformShippingMethodRow>(admin, table, {
    select: "id,shipping_fee",
    id: inFilter(methodIds),
    enabled: "eq.true",
  });
  return new Map(rows.map((row) => [text(row.id), row]));
}

function buildVendorMethodKey(vendorId: string, shippingMethodId: string): string {
  return vendorId + ":" + shippingMethodId;
}

export async function buildCheckoutQuote(
  admin: AdminClient,
  rawInput: unknown,
  rawOptions: CheckoutQuoteOptions = {},
): Promise<CheckoutPriceQuote> {
  const input = unwrapQuoteInput(rawInput);
  const options = { ...defaults, ...rawOptions };

  const items = normalizeItems(input);

  const products = await fetchProducts(
    admin,
    options.productsTable,
    unique(items.map((item) => item.productId)),
  );
  const skus = await fetchSkus(
    admin,
    options.skuTable,
    unique(items.map((item) => item.skuId ?? "")),
  );
  await Promise.all([
    addMissingProductStockOwners(admin, options.productsTable, products),
    addMissingSkuStockOwners(admin, options.skuTable, skus),
  ]);

  const validatedItems: ValidatedItem[] = items.map((item) => {
    const product = products.get(item.productId);
    if (!product) throw new Error("Product not found: " + item.productId);
    if (isFalse(product.is_active)) {
      throw new Error("Product is not available: " + item.productId);
    }

    const sku = item.skuId ? skus.get(item.skuId) : null;
    if (item.skuId && !sku) throw new Error("SKU not found: " + item.skuId);
    if (sku && text(sku.product_id) !== item.productId) {
      throw new Error(`SKU ${item.skuId} does not belong to product ${item.productId}`);
    }
    if (sku && isFalse(sku.is_active)) {
      throw new Error("SKU is not active: " + item.skuId);
    }

    const stock = sku ? resolveSkuStock(sku, skus) : resolveProductStock(product, products);
    if (Number.isFinite(stock) && stock >= 0 && item.quantity > stock) {
      throw new Error(
        `Insufficient stock for product ${item.productId} sku ${item.skuId ?? "null"}`,
      );
    }

    const sourceUnitPrice = Number(
      sku?.price ?? sku?.base_price ?? product.price ?? product.base_price,
    );
    if (!Number.isFinite(sourceUnitPrice) || sourceUnitPrice <= 0) {
      throw new Error("Product price must be greater than zero: " + item.productId);
    }

    const vendorId = text(product.vendor_id);
    if (!vendorId) throw new Error("Product vendor_id is required: " + item.productId);

    return {
      productId: item.productId,
      skuId: item.skuId,
      vendorId,
      quantity: item.quantity,
      sourceCurrency: normalizeCurrencyCode(product.currency),
      sourceUnitPrice,
    };
  });

  const exchangeRates = await fetchLatestExchangeRates(
    admin,
    unique(validatedItems.map((item) => item.sourceCurrency)),
    options,
  );

  const vendorItems = new Map<string, QuotedItem[]>();
  const vendorSubtotals = new Map<string, number>();

  for (const item of validatedItems) {
    const converted = convertAmountToTwd(
      item.sourceUnitPrice,
      item.sourceCurrency,
      exchangeRates,
      item.skuId ? "sku price" : "product price",
    );
    const unitPrice = money(converted.twdAmount);
    const lineTotal = unitPrice * item.quantity;

    const quotedItem: QuotedItem = {
      productId: item.productId,
      skuId: item.skuId,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
    };

    const currentItems = vendorItems.get(item.vendorId) ?? [];
    currentItems.push(quotedItem);
    vendorItems.set(item.vendorId, currentItems);
    vendorSubtotals.set(item.vendorId, (vendorSubtotals.get(item.vendorId) ?? 0) + lineTotal);
  }

  const vendorIds = Array.from(vendorSubtotals.keys());
  const selections = normalizeShippingSelections(input);
  assertShippingSelectionsCoverVendors(vendorIds, selections);

  const selectedShippingMethodIds = unique(Array.from(selections.values()));
  const vendorsById = await fetchVendors(admin, options.vendorsTable, vendorIds);
  const shippingVendorByVendor = new Map(
    vendorIds.map((vendorId) => [vendorId, resolveShippingVendorId(vendorId, vendorsById)]),
  );
  const shippingVendorIds = unique(Array.from(shippingVendorByVendor.values()));
  const [vendorMethods, platformMethods] = await Promise.all([
    fetchVendorMethods(admin, options.vendorShippingMethodsTable, shippingVendorIds),
    fetchPlatformMethods(admin, options.platformShippingMethodsTable, selectedShippingMethodIds),
  ]);

  for (const shippingMethodId of selectedShippingMethodIds) {
    if (!platformMethods.has(shippingMethodId)) {
      throw new Error("Shipping method is not enabled or not found: " + shippingMethodId);
    }
  }

  const enabledVendorMethodKeys = new Set(
    vendorMethods.map((row) =>
      buildVendorMethodKey(text(row.vendor_id), text(row.shipping_method_id)),
    ),
  );
  const vendorMethodLookup = new Map(
    vendorMethods.map((row) => [
      buildVendorMethodKey(text(row.vendor_id), text(row.shipping_method_id)),
      row,
    ]),
  );

  const vendors: VendorQuote[] = vendorIds.map((vendorId) => {
    const shippingMethodId = selections.get(vendorId) ?? "";
    const shippingVendorId = shippingVendorByVendor.get(vendorId) ?? vendorId;
    const vendorMethodKey = buildVendorMethodKey(shippingVendorId, shippingMethodId);
    if (!enabledVendorMethodKeys.has(vendorMethodKey)) {
      throw new Error(
        `Vendor ${vendorId} shipping owner ${shippingVendorId} has not enabled shipping method ${shippingMethodId}`,
      );
    }

    const method = platformMethods.get(shippingMethodId);
    if (!method) {
      throw new Error("Shipping method is not enabled or not found: " + shippingMethodId);
    }

    const itemsSubtotal = vendorSubtotals.get(vendorId) ?? 0;
    const vendorMethod = vendorMethodLookup.get(vendorMethodKey);
    const resolvedShippingFee = money(
      vendorMethod && vendorMethod.shipping_fee_override != null
        ? vendorMethod.shipping_fee_override
        : method.shipping_fee,
    );
    const shippingFee = resolvedShippingFee;

    return {
      vendorId,
      shippingMethodId,
      itemsSubtotal,
      shippingFee,
      totalAmount: itemsSubtotal + shippingFee,
      items: vendorItems.get(vendorId) ?? [],
    };
  });

  const itemsSubtotal = vendors.reduce((sum, vendor) => sum + vendor.itemsSubtotal, 0);
  const shippingFee = vendors.reduce((sum, vendor) => sum + vendor.shippingFee, 0);

  return {
    ok: true,
    currency: "TWD",
    itemsSubtotal,
    shippingFee,
    totalAmount: itemsSubtotal + shippingFee,
    vendors,
  };
}
