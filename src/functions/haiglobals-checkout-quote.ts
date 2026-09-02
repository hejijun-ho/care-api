import { corsHeaders, handleCors } from "../_shared_haiglobals/cors.ts";
import { requireUserAndCreateDatabaseClient } from "../_shared_haiglobals/database.ts";
import {
  buildCheckoutQuote,
  type CheckoutQuoteOptions,
} from "../_shared_haiglobals/checkout_quote.ts";

function getCheckoutQuoteOptions(): CheckoutQuoteOptions {
  return {
    dbSchema: process.env["DB_SCHEMA"] || "haiglobals",
    productsTable: process.env["PRODUCTS_TABLE"] || "products",
    skuTable: process.env["SKU_TABLE"] || "sku",
    exchangeRatesTable: process.env["EXCHANGE_RATES_TABLE"] || "exchange_rates",
    platformShippingMethodsTable:
      process.env["PLATFORM_SHIPPING_METHODS_TABLE"] || "platform_shipping_methods",
    vendorShippingMethodsTable:
      process.env["VENDOR_SHIPPING_METHODS_TABLE"] || "vendor_shipping_methods",
    exchangeRateSource: process.env["EXCHANGE_RATE_SOURCE"] || "openexchangerates",
    exchangeRateBaseCurrency: process.env["EXCHANGE_RATE_BASE_CURRENCY"] || "TWD",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

const handleRequest = async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const { admin } = await requireUserAndCreateDatabaseClient(req);
    const body = await req.json();

    // buildCheckoutQuote already accepts either { checkoutDraft: {...} } or the draft object directly.
    const quote = await buildCheckoutQuote(admin, body, getCheckoutQuoteOptions());

    return jsonResponse(quote);
  } catch (error) {
    console.error("[haiglobals-checkout-quote]", error);

    return jsonResponse(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
};

export default handleRequest;
