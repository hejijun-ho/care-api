import { decryptInvoiceData, encryptInvoiceData } from "../../src/_shared/ecpay_invoice.ts";

type EcpayMockKind =
  | "logisticsCreate"
  | "creditAction"
  | "periodAction"
  | "invoiceIssue"
  | "invoiceInvalid"
  | "invoicePrint";

export type EcpayMockCall = {
  kind: EcpayMockKind;
  url: string;
  method: string;
  body: string;
};

function normalizeUrl(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

async function bodyToText(body: unknown): Promise<string> {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as ArrayBufferView<ArrayBuffer>);
  }
  return String(body);
}

function responseText(
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
): Response {
  return new Response(text, { status, headers: { "Content-Type": contentType } });
}

export class EcpayFetchMock {
  private readonly originalFetch = globalThis.fetch.bind(globalThis);
  private installed = false;
  readonly calls: EcpayMockCall[] = [];

  reset(): void {
    this.calls.length = 0;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      const supabaseUrl = normalizeUrl(process.env.SUPABASE_URL);
      if (supabaseUrl && normalizeUrl(url).startsWith(supabaseUrl)) {
        return await this.originalFetch(input, init);
      }

      const kind = this.kindForUrl(url);
      if (kind) {
        const body = await bodyToText(init?.body);
        this.calls.push({ kind, url, method: init?.method ?? "GET", body });
        return await this.mockResponse(kind, body);
      }

      if (
        (process.env.TEST_BLOCK_EXTERNAL_FETCH ?? "true").toLowerCase() !== "false" &&
        /^https?:/i.test(url)
      ) {
        throw new Error(
          `Blocked unexpected external fetch during API tests: ${url}. ` +
            `Set TEST_BLOCK_EXTERNAL_FETCH=false only if you really want live external calls.`,
        );
      }

      return await this.originalFetch(input, init);
    }) as typeof fetch;
  }

  uninstall(): void {
    if (!this.installed) return;
    globalThis.fetch = this.originalFetch;
    this.installed = false;
  }

  count(kind: EcpayMockKind): number {
    return this.calls.filter((call) => call.kind === kind).length;
  }

  last(kind: EcpayMockKind): EcpayMockCall | undefined {
    return [...this.calls].reverse().find((call) => call.kind === kind);
  }

  private kindForUrl(url: string): EcpayMockKind | null {
    const normalized = normalizeUrl(url);
    const mappings: Array<[EcpayMockKind, string | undefined]> = [
      ["logisticsCreate", process.env.ECPAY_LOGISTICS_CREATE_URL],
      ["creditAction", process.env.ECPAY_CREDIT_ACTION_URL],
      ["periodAction", process.env.ECPAY_CREDIT_PERIOD_ACTION_URL],
      ["invoiceIssue", process.env.ECPAY_INVOICE_ISSUE_URL],
      ["invoiceInvalid", process.env.ECPAY_INVOICE_INVALID_URL],
      ["invoicePrint", process.env.ECPAY_INVOICE_PRINT_URL],
    ];

    for (const [kind, value] of mappings) {
      if (value && normalized === normalizeUrl(value)) return kind;
    }

    return null;
  }

  private async encryptedInvoiceEnvelope(data: Record<string, unknown>): Promise<Response> {
    const hashKey = process.env.ECPAY_INVOICE_HASH_KEY ?? "";
    const hashIv = process.env.ECPAY_INVOICE_HASH_IV ?? "";
    const encrypted = await encryptInvoiceData(data, hashKey, hashIv);
    return responseText(
      JSON.stringify({ TransCode: "1", TransMsg: "OK", Data: encrypted }),
      200,
      "application/json; charset=utf-8",
    );
  }

  // Decrypt the issue request the same way ECPay would, so validation below can
  // inspect the fields the handler actually sent.
  private async decryptIssueRequest(body: string): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(body) as { Data?: unknown };
      const encrypted = String(parsed.Data ?? "").trim();
      if (!encrypted) return {};
      const hashKey = process.env.ECPAY_INVOICE_HASH_KEY ?? "";
      const hashIv = process.env.ECPAY_INVOICE_HASH_IV ?? "";
      return await decryptInvoiceData(encrypted, hashKey, hashIv);
    } catch (_) {
      return {};
    }
  }

  private async mockResponse(kind: EcpayMockKind, body = ""): Promise<Response> {
    console.log("[ECPay mock] fetch intercepted", String(kind));
    switch (kind) {
      case "logisticsCreate":
        return responseText(
          "1|RtnCode=1&RtnMsg=OK&AllPayLogisticsID=QA123456789&BookingNote=QA-BOOKING-001&CVSPaymentNo=QA-CVS-001",
        );
      case "creditAction":
        return responseText("RtnCode=1&RtnMsg=Credit action success");
      case "periodAction":
        return responseText("RtnCode=1&RtnMsg=Period action success");
      case "invoiceIssue": {
        // A printed invoice (Print=1) requires both a buyer name and address;
        // ECPay rejects a missing name with 1200021 and a missing address with
        // 1200023. Mirror both so a regression in either is caught by tests
        // instead of only in production.
        const issueData = await this.decryptIssueRequest(body);
        const wantsPrint = String(issueData.Print ?? "") === "1";
        const customerName = String(issueData.CustomerName ?? "").trim();
        const customerAddr = String(issueData.CustomerAddr ?? "").trim();
        if (wantsPrint && !customerName) {
          return await this.encryptedInvoiceEnvelope({
            RtnCode: 1200021,
            RtnMsg: "列印發票時，客戶(買受人)名稱須有值。",
          });
        }
        if (wantsPrint && !customerAddr) {
          return await this.encryptedInvoiceEnvelope({
            RtnCode: 1200023,
            RtnMsg: "列印發票，買受人地址須有值",
          });
        }
        return await this.encryptedInvoiceEnvelope({
          RtnCode: 1,
          RtnMsg: "Invoice issue success",
          InvoiceNo: `QA${Date.now().toString().slice(-8)}`,
          InvoiceDate: "2026/01/01 12:00:00",
          RandomNumber: "1234",
        });
      }
      case "invoiceInvalid":
        return await this.encryptedInvoiceEnvelope({
          RtnCode: 1,
          RtnMsg: "Invoice invalid success",
          InvoiceNo: `QA${Date.now().toString().slice(-8)}`,
        });
      case "invoicePrint":
        return await this.encryptedInvoiceEnvelope({
          RtnCode: 1,
          RtnMsg: "Invoice print success",
          InvoiceHtml: "<html><body>QA Invoice Print</body></html>",
        });
    }
  }
}
