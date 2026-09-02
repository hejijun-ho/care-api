import { selectRows, type AdminClient } from "./orders.ts";

export type CurrencyExchangeOptions = {
  exchangeRatesTable?: string;
  exchangeRateSource?: string;
  exchangeRateBaseCurrency?: string;
};

type ExchangeRateRow = {
  to_currency?: string | null;
  rate?: number | string | null;
  created_at?: string | null;
};

export type ExchangeRateSnapshot = {
  rate: number;
  createdAt: string | null;
};

export type ConvertedTwdAmount = {
  sourceCurrency: string;
  sourceAmount: number;
  exchangeRateFromTwd: number;
  exchangeRateCreatedAt: string | null;
  twdAmount: number;
};

const defaults: Required<CurrencyExchangeOptions> = {
  exchangeRatesTable: "exchange_rates",
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
  return `in.(${unique(values).join(",")})`;
}

function positiveNumber(value: unknown, field: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be greater than zero`);
  }
  return parsed;
}

export function normalizeCurrencyCode(value: unknown, fallback = "TWD"): string {
  return text(value).toUpperCase() || fallback;
}

export async function fetchLatestExchangeRates(
  admin: AdminClient,
  currencies: string[],
  rawOptions: CurrencyExchangeOptions = {},
): Promise<Map<string, ExchangeRateSnapshot>> {
  const options = { ...defaults, ...rawOptions };
  const baseCurrency = normalizeCurrencyCode(options.exchangeRateBaseCurrency, "TWD");
  const targetCurrencies = unique(
    currencies.map((currency) => normalizeCurrencyCode(currency)),
  ).filter((currency) => currency && currency !== baseCurrency);
  const rates = new Map<string, ExchangeRateSnapshot>();

  if (targetCurrencies.length === 0) {
    return rates;
  }

  const rows = await selectRows<ExchangeRateRow>(admin, options.exchangeRatesTable, {
    select: "to_currency,rate,created_at",
    source: `eq.${options.exchangeRateSource}`,
    from_currency: `eq.${baseCurrency}`,
    to_currency: inFilter(targetCurrencies),
    order: "created_at.desc",
  });

  for (const row of rows) {
    const currency = normalizeCurrencyCode(row.to_currency);
    if (!currency || rates.has(currency)) continue;

    const rate = Number(row.rate ?? 0);
    if (!Number.isFinite(rate) || rate <= 0) continue;

    rates.set(currency, {
      rate,
      createdAt: text(row.created_at) || null,
    });
  }

  const missing = targetCurrencies.filter((currency) => !rates.has(currency));
  if (missing.length > 0) {
    throw new Error(`Missing exchange rates for currencies: ${missing.join(", ")}`);
  }

  return rates;
}

export function convertAmountToTwd(
  amount: unknown,
  currency: unknown,
  rates: Map<string, ExchangeRateSnapshot>,
  field = "amount",
): ConvertedTwdAmount {
  const sourceCurrency = normalizeCurrencyCode(currency);
  const sourceAmount = positiveNumber(amount, field);

  if (sourceCurrency === "TWD") {
    return {
      sourceCurrency,
      sourceAmount,
      exchangeRateFromTwd: 1,
      exchangeRateCreatedAt: null,
      twdAmount: Math.round(sourceAmount),
    };
  }

  const snapshot = rates.get(sourceCurrency);
  if (!snapshot) {
    throw new Error(`Missing exchange rate for currency: ${sourceCurrency}`);
  }

  const twdAmount = Math.round(sourceAmount / snapshot.rate);
  if (!Number.isFinite(twdAmount) || twdAmount <= 0) {
    throw new Error(`${field} converts to an invalid TWD amount`);
  }

  return {
    sourceCurrency,
    sourceAmount,
    exchangeRateFromTwd: snapshot.rate,
    exchangeRateCreatedAt: snapshot.createdAt,
    twdAmount,
  };
}
