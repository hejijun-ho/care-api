import {
  deleteRows,
  extractMissingColumnName,
  insertRows,
  queryString,
  restRequest,
  selectOne,
  selectRows,
  type AdminClient,
  type CheckoutOrderInput,
  type CheckoutShippingSelectionInput,
  type OrderRow,
  type ProductRow,
  type UserContactRow,
} from "./orders.ts";
import {
  convertAmountToTwd,
  fetchLatestExchangeRates,
  normalizeCurrencyCode,
} from "./currency_exchange.ts";

function coercePositiveInt(value: unknown, field: string): number {
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
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function normalizePaymentMethod(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  switch (normalized) {
    case "credit":
    case "credit_card":
      return "credit_card";
    case "atm":
    case "webatm":
    case "web_atm":
      return "atm";
    case "cvs":
    case "cvs_code":
    case "convenience_store_code":
      return "cvs_code";
    case "barcode":
    case "cvs_barcode":
    case "convenience_store_barcode":
      return "cvs_barcode";
    case "applepay":
    case "apple_pay":
      return "apple_pay";
    case "cash":
    case "cash_on_delivery":
    case "cod":
      return "cod";
    default:
      throw new Error(`Unsupported paymentMethod: ${normalized || "<empty>"}`);
  }
}

function normalizeDeliveryMethod(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "cvs" || normalized === "store_pickup") {
    return "cvs";
  }
  if (normalized === "home_delivery") {
    return "home_delivery";
  }
  throw new Error(`Unsupported deliveryMethod: ${normalized || "<empty>"}`);
}

function normalizeInvoiceType(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!["personal", "carrier", "company"].includes(normalized)) {
    throw new Error(`Unsupported invoiceType: ${normalized || "<empty>"}`);
  }
  return normalized;
}

function buildOrderNo(paymentProvider: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  });
  const stamp = formatter.format(now).replace(/\D/g, "");
  return `${paymentProvider === "ecpay" ? "OSE" : "OSO"}${stamp}`;
}

function normalizeLogisticsSubType(value: unknown, isCvs: boolean): string {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!isCvs) {
    return normalized || "TCAT";
  }
  switch (normalized) {
    case "":
    case "UNIMART":
    case "UNIMARTFREEZE":
    case "UNIMARTC2C":
      return "UNIMARTC2C";
    case "FAMI":
    case "FAMIC2C":
      return "FAMIC2C";
    case "HILIFE":
    case "HILIFEC2C":
      return "HILIFEC2C";
    case "OKMART":
    case "OKMARTC2C":
      return "OKMARTC2C";
    default:
      return normalized;
  }
}

function requireText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function normalizePhoneWithDialCode(value: unknown, field: string): string {
  let phone = String(value ?? "")
    .trim()
    .replace(/[\s().-]/g, "");
  if (!phone) {
    throw new Error(`${field} is required`);
  }
  if (phone.startsWith("00")) {
    phone = `+${phone.slice(2)}`;
  } else if (!phone.startsWith("+")) {
    phone = phone.startsWith("09") ? `+886${phone.slice(1)}` : `+${phone}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error(`${field} must include a dial code, e.g. +886912345678`);
  }
  return phone;
}

export async function fetchUserEmail(admin: AdminClient, userId: string): Promise<string> {
  const user = await selectOne<UserContactRow>(admin, "users", {
    select: "email",
    id: `eq.${userId}`,
  });
  return String(user?.email ?? "").trim();
}

type SkuRow = {
  id: string;
  product_id: string;
  name?: string | null;
  base_price?: number | string | null;
  price?: number | string | null;
  special_price?: number | string | null;
  is_active?: boolean | string | null;
  image_url?: string | null;
  stock?: number | string | null;
  stock_owner_sku_id?: string | null;
};

type PlatformShippingMethodRow = {
  id: string;
  provider?: string | null;
  logistics_type?: string | null;
  logistics_sub_type?: string | null;
  shipping_fee?: number | string | null;
  is_collection_supported?: boolean | string | null;
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

type NormalizedShippingSelection = {
  vendorId: string;
  shippingMethodId?: string;
  deliveryMethod?: string;
  logisticsSubType?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  recipientCountryCode?: string;
  recipientZipcode?: string;
  pickupStoreName?: string;
  pickupStoreCode?: string;
  pickupStoreAddress?: string;
};

type ShippingMethodCache = {
  byId: Map<string, PlatformShippingMethodRow>;
  byType: Map<string, PlatformShippingMethodRow>;
};

type ShipmentPlan = {
  vendorId: string;
  shippingOwnerVendorId: string;
  vendorAmount: number;
  shippingMethod: PlatformShippingMethodRow;
  logisticsType: string;
  logisticsSubType: string;
  isCvs: boolean;
  shippingFee: number;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  receiverCountryCode: string;
  receiverZipcode: string;
  pickupStoreName: string;
  pickupStoreCode: string;
  pickupStoreAddress: string;
};

type ValidatedOrderItem = {
  order_id: string;
  sku_id: string | null;
  product_id: string;
  product_name: string;
  image_url: string;
  sku_name: string | null;
  vendor_id: string;
  quantity: number;
  source_currency: string;
  source_unit_price: number;
  created_at: string;
  updated_at: string;
};

function optionalText(value: unknown): string {
  return String(value ?? "").trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = optionalText(value);
    if (text) return text;
  }
  return "";
}

function normalizeShippingSelections(
  selections: CheckoutShippingSelectionInput[] | undefined,
): Map<string, NormalizedShippingSelection> {
  const byVendor = new Map<string, NormalizedShippingSelection>();
  for (let index = 0; index < (selections ?? []).length; index += 1) {
    const selection = selections![index] ?? {};
    const vendorId = firstText(selection.vendorId, selection.vendor_id);
    if (!vendorId) {
      throw new Error(`shippingSelections[${index}].vendorId is required`);
    }
    if (byVendor.has(vendorId)) {
      throw new Error(`Duplicate shippingSelections vendorId: ${vendorId}`);
    }
    const shippingMethodId = firstText(selection.shippingMethodId, selection.shipping_method_id);
    if (!shippingMethodId) {
      throw new Error(`shippingSelections[${index}].shippingMethodId is required`);
    }
    byVendor.set(vendorId, {
      vendorId,
      shippingMethodId,
      deliveryMethod: firstText(selection.deliveryMethod, selection.delivery_method),
      logisticsSubType: firstText(selection.logisticsSubType, selection.logistics_sub_type),
      recipientName: firstText(selection.recipientName, selection.recipient_name),
      recipientPhone: firstText(selection.recipientPhone, selection.recipient_phone),
      recipientAddress: firstText(selection.recipientAddress, selection.recipient_address),
      recipientCountryCode: firstText(
        selection.recipientCountryCode,
        selection.recipient_country_code,
      ),
      recipientZipcode: firstText(
        selection.recipientZipcode,
        selection.recipient_zipcode,
        selection.recipientZipCode,
        selection.recipient_zip_code,
      ),
      pickupStoreName: firstText(selection.pickupStoreName, selection.pickup_store_name),
      pickupStoreCode: firstText(selection.pickupStoreCode, selection.pickup_store_code),
      pickupStoreAddress: firstText(selection.pickupStoreAddress, selection.pickup_store_address),
    });
  }
  return byVendor;
}

function normalizePlatformLogisticsType(value: unknown): string {
  const normalized = optionalText(value).toUpperCase();
  if (normalized === "CVS" || normalized === "HOME") {
    return normalized;
  }
  throw new Error(`Unsupported platform shipping logistics_type: ${normalized || "<empty>"}`);
}

function shippingFeeForMethod(
  method: PlatformShippingMethodRow,
  vendorMethod?: VendorShippingMethodRow | null,
): number {
  const candidate =
    vendorMethod && vendorMethod.shipping_fee_override != null
      ? vendorMethod.shipping_fee_override
      : method.shipping_fee;
  const shippingFee = Number(candidate ?? 0);
  if (!Number.isFinite(shippingFee) || shippingFee < 0) {
    throw new Error("shipping fee must be zero or greater");
  }
  return Math.round(shippingFee);
}

async function fetchCheckoutProducts(
  admin: AdminClient,
  productIds: string[],
): Promise<Map<string, ProductRow>> {
  const rows = await selectRows<ProductRow>(admin, "products", {
    // price and is_active are generated read-only columns.
    // price reflects base_price/special_price; is_active reflects published/review_status.
    select:
      "id,name,base_price,price,special_price,is_active,image_url,vendor_id,stock,stock_owner_product_id,currency",
    id: `in.(${productIds.join(",")})`,
  });
  return new Map(rows.map((row) => [String(row.id ?? "").trim(), row]));
}

async function fetchCheckoutSkusByIds(
  admin: AdminClient,
  skuIds: string[],
): Promise<Map<string, SkuRow>> {
  if (skuIds.length === 0) return new Map();
  const rows = await selectRows<SkuRow>(admin, "sku", {
    select:
      "id,product_id,name,base_price,price,special_price,is_active,image_url,stock,stock_owner_sku_id",
    id: `in.(${skuIds.join(",")})`,
  });
  return new Map(rows.map((row) => [String(row.id ?? "").trim(), row]));
}

async function addMissingCheckoutProductStockOwners(
  admin: AdminClient,
  products: Map<string, ProductRow>,
): Promise<void> {
  const ownerIds = Array.from(
    new Set(
      Array.from(products.values())
        .map((product) => optionalText(product.stock_owner_product_id))
        .filter((ownerId) => ownerId && !products.has(ownerId)),
    ),
  );
  if (ownerIds.length === 0) return;

  const owners = await fetchCheckoutProducts(admin, ownerIds);
  for (const [id, owner] of owners) products.set(id, owner);
}

async function addMissingCheckoutSkuStockOwners(
  admin: AdminClient,
  skus: Map<string, SkuRow>,
): Promise<void> {
  const ownerIds = Array.from(
    new Set(
      Array.from(skus.values())
        .map((sku) => optionalText(sku.stock_owner_sku_id))
        .filter((ownerId) => ownerId && !skus.has(ownerId)),
    ),
  );
  if (ownerIds.length === 0) return;

  const owners = await fetchCheckoutSkusByIds(admin, ownerIds);
  for (const [id, owner] of owners) skus.set(id, owner);
}

function resolveCheckoutProductStock(
  product: ProductRow,
  products: Map<string, ProductRow>,
): number {
  const ownerId = optionalText(product.stock_owner_product_id) || optionalText(product.id);
  const owner = products.get(ownerId);
  if (!owner) {
    throw new Error(`Stock owner product not found: ${ownerId}`);
  }
  return Number(owner.stock ?? 999999);
}

function resolveCheckoutSkuStock(sku: SkuRow, skus: Map<string, SkuRow>): number {
  const ownerId = optionalText(sku.stock_owner_sku_id) || optionalText(sku.id);
  const owner = skus.get(ownerId);
  if (!owner) {
    throw new Error(`Stock owner sku not found: ${ownerId}`);
  }
  return Number(owner.stock ?? 999999);
}

async function fetchCheckoutSkusByProductIds(
  admin: AdminClient,
  productIds: string[],
): Promise<Map<string, SkuRow[]>> {
  const rows = await selectRows<SkuRow>(admin, "sku", {
    select: "id,product_id,is_active",
    product_id: `in.(${productIds.join(",")})`,
  });
  const byProduct = new Map<string, SkuRow[]>();
  for (const row of rows) {
    const productId = String(row.product_id ?? "").trim();
    if (!productId) continue;
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), row]);
  }
  return byProduct;
}

async function fetchPlatformShippingMethod(
  admin: AdminClient,
  logisticsType: string,
  logisticsSubType: string,
): Promise<PlatformShippingMethodRow> {
  const method = await selectOne<PlatformShippingMethodRow>(admin, "platform_shipping_methods", {
    select: "id,provider,logistics_type,logistics_sub_type,shipping_fee,is_collection_supported",
    logistics_type: `eq.${logisticsType}`,
    logistics_sub_type: `eq.${logisticsSubType}`,
    enabled: "eq.true",
  });
  if (!method?.id) {
    throw new Error(
      `Enabled platform shipping method not found: ${logisticsType}/${logisticsSubType}`,
    );
  }
  return method;
}

async function fetchPlatformShippingMethodById(
  admin: AdminClient,
  shippingMethodId: string,
): Promise<PlatformShippingMethodRow> {
  const method = await selectOne<PlatformShippingMethodRow>(admin, "platform_shipping_methods", {
    select: "id,provider,logistics_type,logistics_sub_type,shipping_fee,is_collection_supported",
    id: `eq.${shippingMethodId}`,
    enabled: "eq.true",
  });
  if (!method?.id) {
    throw new Error(`Enabled platform shipping method not found: ${shippingMethodId}`);
  }
  return method;
}

async function fetchVendorShippingMethod(
  admin: AdminClient,
  vendorId: string,
  shippingMethodId: string,
): Promise<VendorShippingMethodRow> {
  const row = await selectOne<VendorShippingMethodRow>(admin, "vendor_shipping_methods", {
    select: "vendor_id,shipping_method_id,shipping_fee_override",
    vendor_id: `eq.${vendorId}`,
    shipping_method_id: `eq.${shippingMethodId}`,
  });
  if (!row) {
    throw new Error(`Vendor ${vendorId} has not enabled shipping_method_id ${shippingMethodId}`);
  }
  return row;
}

async function fetchCheckoutVendors(
  admin: AdminClient,
  vendorIds: string[],
): Promise<Map<string, VendorRow>> {
  if (vendorIds.length === 0) return new Map();
  const rows = await selectRows<VendorRow>(admin, "vendors", {
    select: "id,root_vendor_id",
    id: `in.(${vendorIds.join(",")})`,
  });
  return new Map(rows.map((row) => [optionalText(row.id), row]));
}

function resolveCheckoutShippingVendorId(
  vendorId: string,
  vendors: Map<string, VendorRow>,
): string {
  return optionalText(vendors.get(vendorId)?.root_vendor_id) || vendorId;
}

function assertCollectionSupported(plan: ShipmentPlan): void {
  if (plan.shippingMethod.is_collection_supported === true) {
    return;
  }

  if (
    String(plan.shippingMethod.is_collection_supported ?? "")
      .trim()
      .toLowerCase() === "true"
  ) {
    return;
  }

  const provider = String(plan.shippingMethod.provider ?? "ecpay").trim() || "ecpay";
  const logisticsType =
    String(plan.shippingMethod.logistics_type ?? plan.logisticsType).trim() || plan.logisticsType;
  const logisticsSubType =
    String(plan.shippingMethod.logistics_sub_type ?? plan.logisticsSubType).trim() ||
    plan.logisticsSubType;
  throw new Error(
    `Shipping method does not support COD collection: ${provider}/${logisticsType}/${logisticsSubType}`,
  );
}

async function resolveShippingMethod(
  admin: AdminClient,
  selection: NormalizedShippingSelection,
  cache: ShippingMethodCache,
): Promise<{
  shippingMethod: PlatformShippingMethodRow;
  logisticsType: string;
  logisticsSubType: string;
  isCvs: boolean;
}> {
  if (selection.shippingMethodId) {
    let shippingMethod = cache.byId.get(selection.shippingMethodId);
    if (!shippingMethod) {
      shippingMethod = await fetchPlatformShippingMethodById(admin, selection.shippingMethodId);
      cache.byId.set(selection.shippingMethodId, shippingMethod);
    }

    const logisticsType = normalizePlatformLogisticsType(shippingMethod.logistics_type);
    const isCvs = logisticsType === "CVS";
    const logisticsSubType = normalizeLogisticsSubType(shippingMethod.logistics_sub_type, isCvs);

    if (selection.deliveryMethod) {
      const requestedDeliveryMethod = normalizeDeliveryMethod(selection.deliveryMethod);
      const requestedLogisticsType = requestedDeliveryMethod === "cvs" ? "CVS" : "HOME";
      if (requestedLogisticsType !== logisticsType) {
        throw new Error(
          `shippingSelections vendor ${selection.vendorId} deliveryMethod does not match shippingMethodId`,
        );
      }
    }

    if (selection.logisticsSubType) {
      const requestedSubType = normalizeLogisticsSubType(selection.logisticsSubType, isCvs);
      if (requestedSubType !== logisticsSubType) {
        throw new Error(
          `shippingSelections vendor ${selection.vendorId} logisticsSubType does not match shippingMethodId`,
        );
      }
    }

    return { shippingMethod, logisticsType, logisticsSubType, isCvs };
  }

  const deliveryMethod = normalizeDeliveryMethod(selection.deliveryMethod);
  const isCvs = deliveryMethod === "cvs";
  const logisticsSubType = normalizeLogisticsSubType(selection.logisticsSubType, isCvs);
  const logisticsType = isCvs ? "CVS" : "HOME";
  const cacheKey = `${logisticsType}/${logisticsSubType}`;
  let shippingMethod = cache.byType.get(cacheKey);
  if (!shippingMethod) {
    shippingMethod = await fetchPlatformShippingMethod(admin, logisticsType, logisticsSubType);
    cache.byType.set(cacheKey, shippingMethod);
  }
  return { shippingMethod, logisticsType, logisticsSubType, isCvs };
}

async function buildShipmentPlan(
  admin: AdminClient,
  vendorId: string,
  shippingOwnerVendorId: string,
  vendorAmount: number,
  selection: NormalizedShippingSelection,
  input: CheckoutOrderInput,
  defaults: {
    recipientName: string;
    recipientPhone: string;
    recipientAddress: string;
    recipientCountryCode: string;
    recipientZipcode: string;
  },
  cache: ShippingMethodCache,
): Promise<ShipmentPlan> {
  const { shippingMethod, logisticsType, logisticsSubType, isCvs } = await resolveShippingMethod(
    admin,
    selection,
    cache,
  );
  const vendorShippingMethod = await fetchVendorShippingMethod(
    admin,
    shippingOwnerVendorId,
    shippingMethod.id,
  );

  const receiverName = firstText(selection.recipientName, defaults.recipientName);
  const receiverPhone = selection.recipientPhone
    ? normalizePhoneWithDialCode(
        selection.recipientPhone,
        `shippingSelections[${vendorId}].recipientPhone`,
      )
    : defaults.recipientPhone;
  const receiverAddress = firstText(selection.recipientAddress, defaults.recipientAddress);
  // Current rule: all CVS shipments are Taiwan pickups, so persist receiver_country as TW.
  // If cross-border CVS is introduced later, change this branch to resolve country by store/country metadata.
  const receiverCountryCode = isCvs
    ? "TW"
    : firstText(selection.recipientCountryCode, defaults.recipientCountryCode).toUpperCase() ||
      "TW";
  const receiverZipcode = firstText(selection.recipientZipcode, defaults.recipientZipcode);
  const pickupStoreName = firstText(selection.pickupStoreName, input.pickupStoreName);
  const pickupStoreCode = firstText(selection.pickupStoreCode, input.pickupStoreCode);
  const pickupStoreAddress = firstText(selection.pickupStoreAddress, input.pickupStoreAddress);

  if (!isCvs && !receiverAddress) {
    throw new Error(`recipientAddress is required for vendor ${vendorId}`);
  }
  if (isCvs && !pickupStoreCode) {
    throw new Error(`pickupStoreCode is required for vendor ${vendorId}`);
  }

  return {
    vendorId,
    shippingOwnerVendorId,
    vendorAmount,
    shippingMethod,
    logisticsType,
    logisticsSubType,
    isCvs,
    shippingFee: shippingFeeForMethod(shippingMethod, vendorShippingMethod),
    receiverName,
    receiverPhone,
    receiverAddress,
    receiverCountryCode,
    receiverZipcode,
    pickupStoreName,
    pickupStoreCode,
    pickupStoreAddress,
  };
}

export async function createCheckoutOrder(
  admin: AdminClient,
  input: CheckoutOrderInput,
): Promise<OrderRow> {
  const paymentProvider = String(input.paymentProvider ?? "ecpay")
    .trim()
    .toLowerCase();
  if (paymentProvider !== "ecpay") {
    throw new Error(`Unsupported paymentProvider: ${paymentProvider || "<empty>"}`);
  }
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const invoiceType = normalizeInvoiceType(input.invoiceType);
  const recipientName = requireText(input.recipientName, "recipientName");
  const recipientPhone = normalizePhoneWithDialCode(input.recipientPhone, "recipientPhone");
  const userEmail = await fetchUserEmail(admin, input.userId.trim());
  const recipientAddress = String(input.recipientAddress ?? "").trim();
  const recipientCountryCode =
    String(input.recipientCountryCode ?? "")
      .trim()
      .toUpperCase() || "TW";
  const recipientZipcode = String(input.recipientZipcode ?? "").trim();
  const shippingSelections = normalizeShippingSelections(input.shippingSelections);
  if (invoiceType === "carrier") {
    if (
      String(input.invoiceCarrierType ?? "")
        .trim()
        .toLowerCase() !== "mobile"
    ) {
      throw new Error("Unsupported invoiceCarrierType");
    }
    requireText(input.invoiceCarrierNo, "invoiceCarrierNo");
  }
  if (invoiceType === "company") {
    requireText(input.invoiceCompanyTitle, "invoiceCompanyTitle");
    requireText(input.invoiceTaxId, "invoiceTaxId");
  }

  const requestedItems = input.items
    .map((item) => ({
      product_id: String(item.product_id ?? "").trim(),
      sku_id: String(item.sku_id ?? "").trim() || null,
      quantity: coercePositiveInt(item.quantity, "quantity"),
    }))
    .filter((item) => item.product_id);
  if (requestedItems.length === 0) {
    throw new Error("Order items are required");
  }

  const productIds = Array.from(new Set(requestedItems.map((item) => item.product_id)));
  const skuIds = Array.from(
    new Set(requestedItems.map((item) => item.sku_id).filter((id): id is string => Boolean(id))),
  );
  const products = await fetchCheckoutProducts(admin, productIds);
  const skusById = await fetchCheckoutSkusByIds(admin, skuIds);
  await Promise.all([
    addMissingCheckoutProductStockOwners(admin, products),
    addMissingCheckoutSkuStockOwners(admin, skusById),
  ]);
  const skusByProduct = await fetchCheckoutSkusByProductIds(admin, productIds);
  const nowIso = new Date().toISOString();
  const validatedItems: ValidatedOrderItem[] = requestedItems.map((item) => {
    const product = products.get(item.product_id);
    if (!product) {
      throw new Error(`Product not found: ${item.product_id}`);
    }
    if (String(product.is_active ?? "true").toLowerCase() === "false") {
      throw new Error(`Product is not active: ${item.product_id}`);
    }

    const productSkus = skusByProduct.get(item.product_id) ?? [];
    const sku = item.sku_id ? skusById.get(item.sku_id) : null;
    if (item.sku_id && !sku) {
      throw new Error(`SKU not found: ${item.sku_id}`);
    }
    if (sku && String(sku.product_id ?? "").trim() !== item.product_id) {
      throw new Error(`SKU ${item.sku_id} does not belong to product ${item.product_id}`);
    }
    if (!sku && productSkus.length > 0) {
      throw new Error(`sku_id is required for product: ${item.product_id}`);
    }
    if (sku && String(sku.is_active ?? "true").toLowerCase() === "false") {
      throw new Error(`SKU is not active: ${item.sku_id}`);
    }

    const sourceUnitPrice = Number(
      sku?.price ?? sku?.base_price ?? product.price ?? product.base_price,
    );
    if (!Number.isFinite(sourceUnitPrice) || sourceUnitPrice <= 0) {
      throw new Error(`${sku ? "sku" : "product"} price must be a positive integer`);
    }

    const stock = sku
      ? resolveCheckoutSkuStock(sku, skusById)
      : resolveCheckoutProductStock(product, products);
    if (Number.isFinite(stock) && stock >= 0 && item.quantity > stock) {
      throw new Error(
        `Insufficient stock for ${sku ? "sku" : "product"}: ${sku?.id ?? item.product_id}`,
      );
    }
    const vendorId = String(product.vendor_id ?? "").trim();
    if (!vendorId) {
      throw new Error(`Product vendor_id is required: ${item.product_id}`);
    }
    return {
      order_id: "",
      sku_id: sku?.id ?? null,
      product_id: item.product_id,
      product_name: String(product.name ?? "").trim(),
      image_url: String(sku?.image_url ?? product.image_url ?? "").trim(),
      sku_name: sku ? String(sku.name ?? "").trim() || null : null,
      vendor_id: vendorId,
      quantity: item.quantity,
      source_currency: normalizeCurrencyCode(product.currency),
      source_unit_price: sourceUnitPrice,
      created_at: nowIso,
      updated_at: nowIso,
    };
  });

  const exchangeRates = await fetchLatestExchangeRates(
    admin,
    validatedItems.map((item) => item.source_currency),
    {
      exchangeRatesTable: process.env["EXCHANGE_RATES_TABLE"] || "exchange_rates",
      exchangeRateSource: process.env["EXCHANGE_RATE_SOURCE"] || "openexchangerates",
      exchangeRateBaseCurrency: process.env["EXCHANGE_RATE_BASE_CURRENCY"] || "TWD",
    },
  );

  let itemsSubtotal = 0;
  const orderItemRows = validatedItems.map((item) => {
    const converted = convertAmountToTwd(
      item.source_unit_price,
      item.source_currency,
      exchangeRates,
      item.sku_id ? "sku price" : "product price",
    );
    const unitPrice = converted.twdAmount;
    const lineTotal = unitPrice * item.quantity;
    itemsSubtotal += lineTotal;
    return {
      order_id: item.order_id,
      sku_id: item.sku_id,
      product_id: item.product_id,
      product_name: item.product_name,
      image_url: item.image_url,
      sku_name: item.sku_name,
      vendor_id: item.vendor_id,
      unit_price: unitPrice,
      quantity: item.quantity,
      currency: "TWD",
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  });

  if (itemsSubtotal <= 0) {
    throw new Error("Order total_amount must be greater than zero");
  }

  const shipmentAmountsByVendor = new Map<string, number>();
  for (const row of orderItemRows) {
    const vendorId = String(row.vendor_id ?? "").trim();
    const lineTotal = Number(row.unit_price ?? 0) * Number(row.quantity ?? 0);
    shipmentAmountsByVendor.set(vendorId, (shipmentAmountsByVendor.get(vendorId) ?? 0) + lineTotal);
  }
  for (const vendorId of shippingSelections.keys()) {
    if (!shipmentAmountsByVendor.has(vendorId)) {
      throw new Error(`shippingSelections contains vendor without order items: ${vendorId}`);
    }
  }

  const shippingMethodCache: ShippingMethodCache = { byId: new Map(), byType: new Map() };
  const vendorsById = await fetchCheckoutVendors(admin, Array.from(shipmentAmountsByVendor.keys()));
  const shipmentPlans: ShipmentPlan[] = [];
  for (const [vendorId, vendorAmount] of shipmentAmountsByVendor.entries()) {
    const shippingOwnerVendorId = resolveCheckoutShippingVendorId(vendorId, vendorsById);
    const selection =
      shippingSelections.size > 0
        ? shippingSelections.get(vendorId)
        : {
            vendorId,
            deliveryMethod: String(input.deliveryMethod ?? "").trim(),
            logisticsSubType: String(input.logisticsSubType ?? "").trim(),
          };
    if (!selection) {
      throw new Error(`shippingSelections missing for vendor ${vendorId}`);
    }
    shipmentPlans.push(
      await buildShipmentPlan(
        admin,
        vendorId,
        shippingOwnerVendorId,
        vendorAmount,
        selection,
        input,
        {
          recipientName,
          recipientPhone,
          recipientAddress,
          recipientCountryCode,
          recipientZipcode,
        },
        shippingMethodCache,
      ),
    );
  }
  if (paymentMethod === "cod") {
    for (const plan of shipmentPlans) {
      assertCollectionSupported(plan);
    }
  }
  const shippingFee = shipmentPlans.reduce((sum, plan) => sum + plan.shippingFee, 0);
  const totalAmount = itemsSubtotal + shippingFee;

  let createdOrder: OrderRow | null = null;
  try {
    const orderRows = await insertRows<OrderRow>(admin, "orders", {
      user_id: input.userId.trim(),
      order_number: buildOrderNo(paymentProvider),
      items_subtotal: itemsSubtotal,
      shipping_fee: shippingFee,
      total_amount: totalAmount,
      currency: "TWD",
      payment_status: "pending",
      payment_provider: paymentProvider,
      payment_method: paymentMethod,
      paid_at: null,
      provider_transaction_id: null,
      provider_order_id: null,
      provider_status_code: null,
      provider_status_message: null,
      bank_code: null,
      virtual_account: null,
      payment_reference_no: null,
      payment_url: null,
    });
    createdOrder = orderRows[0] ?? null;
    if (!createdOrder?.id) {
      throw new Error("Failed to create order");
    }

    if (invoiceType) {
      await insertRows(admin, "order_invoices", {
        order_id: createdOrder.id,
        invoice_provider: "ecpay",
        invoice_status: "pending",
        invoice_type: invoiceType,
        invoice_carrier_type: String(input.invoiceCarrierType ?? "").trim(),
        invoice_carrier_no: String(input.invoiceCarrierNo ?? "").trim(),
        invoice_company_title: String(input.invoiceCompanyTitle ?? "").trim(),
        invoice_tax_id: String(input.invoiceTaxId ?? "").trim(),
        invoice_email: userEmail || null,
        invoice_love_code: null,
      });
    }

    const shipmentRows = shipmentPlans.map((plan) => ({
      order_id: createdOrder!.id,
      vendor_id: plan.vendorId,
      shipping_method_id: plan.shippingMethod.id,
      shipping_provider: String(plan.shippingMethod.provider ?? "ecpay").trim() || "ecpay",
      logistics_type:
        String(plan.shippingMethod.logistics_type ?? plan.logisticsType).trim() ||
        plan.logisticsType,
      logistics_sub_type:
        String(plan.shippingMethod.logistics_sub_type ?? plan.logisticsSubType).trim() ||
        plan.logisticsSubType,
      shipping_status: "pending",
      is_collection: paymentMethod === "cod",
      collection_amount: paymentMethod === "cod" ? plan.vendorAmount + plan.shippingFee : null,
      receiver_name: plan.receiverName,
      receiver_phone: plan.receiverPhone,
      receiver_email: userEmail || null,
      receiver_address: plan.receiverAddress,
      receiver_country: plan.receiverCountryCode || null,
      receiver_zip_code: plan.isCvs ? null : plan.receiverZipcode || null,
      cvs_store_id: plan.isCvs ? plan.pickupStoreCode : "",
      cvs_store_name: plan.isCvs ? plan.pickupStoreName : "",
      cvs_store_address: plan.isCvs ? plan.pickupStoreAddress : "",
      cvs_store_type: plan.isCvs ? plan.logisticsSubType : null,
      shipping_fee: plan.shippingFee,
      goods_amount: plan.vendorAmount,
    }));
    try {
      await insertRows(admin, "order_shipments", shipmentRows);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missingColumn = extractMissingColumnName(message);
      if (missingColumn !== "receiver_country" && missingColumn !== "receiver_zip_code") {
        throw error;
      }
      const compatibleRows = shipmentRows.map((row) => {
        const { receiver_country: _country, receiver_zip_code: _zipCode, ...rest } = row;
        return rest;
      });
      await insertRows(admin, "order_shipments", compatibleRows);
    }

    const itemPayload = orderItemRows.map((row) => ({
      ...row,
      order_id: createdOrder!.id,
    }));
    const insertedItems = await insertRows<Record<string, unknown>>(
      admin,
      "order_items",
      itemPayload,
    );
    for (let index = 0; index < insertedItems.length; index += 1) {
      const insertedItem = insertedItems[index] ?? {};
      const itemId = String(insertedItem.id ?? "").trim();
      if (!itemId) continue;
      const snapshot = itemPayload[index];
      await restRequest<void>(admin, "order_items", queryString({ id: `eq.${itemId}` }), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          unit_price: snapshot.unit_price,
          currency: snapshot.currency,
          updated_at: nowIso,
        }),
      });
    }
    return createdOrder;
  } catch (error) {
    if (createdOrder?.id) {
      await deleteRows(admin, "order_items", { order_id: `eq.${createdOrder.id}` }).catch(() => {});
      await deleteRows(admin, "order_shipments", { order_id: `eq.${createdOrder.id}` }).catch(
        () => {},
      );
      await deleteRows(admin, "order_invoices", { order_id: `eq.${createdOrder.id}` }).catch(
        () => {},
      );
      await deleteRows(admin, "orders", { id: `eq.${createdOrder.id}` }).catch(() => {});
    }
    throw error;
  }
}
