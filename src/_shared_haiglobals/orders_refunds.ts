import {
  insertRows,
  queryString,
  restRequest,
  selectOne,
  selectRows,
  type AdminClient,
  type CreateOrderRefundInput,
  type OrderRefundRow,
  type UpdateOrderRefundInput,
} from "./orders.ts";

export async function createOrderRefundRecord(
  admin: AdminClient,
  input: CreateOrderRefundInput,
): Promise<OrderRefundRow> {
  const nowIso = new Date().toISOString();
  const rows = await insertRows<OrderRefundRow>(admin, "order_refunds", {
    status: "requesting",
    ...input,
    created_at: nowIso,
    updated_at: nowIso,
  });
  const created = rows[0] ?? null;
  if (!created?.id) {
    throw new Error("Failed to create order refund record");
  }
  return created;
}

export async function updateOrderRefundRecord(
  admin: AdminClient,
  refundId: string,
  input: UpdateOrderRefundInput,
): Promise<void> {
  if (!refundId.trim()) {
    throw new Error("refundId is required");
  }
  await restRequest<void>(admin, "order_refunds", queryString({ id: `eq.${refundId}` }), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      ...input,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function fetchOrderRefundsByOrderId(
  admin: AdminClient,
  orderId: string,
): Promise<OrderRefundRow[]> {
  return await selectRows<OrderRefundRow>(admin, "order_refunds", {
    select: "*",
    order_id: `eq.${orderId}`,
    order: "created_at.desc",
  });
}

export async function fetchLatestOrderRefundByOrderId(
  admin: AdminClient,
  orderId: string,
): Promise<OrderRefundRow | null> {
  return await selectOne<OrderRefundRow>(admin, "order_refunds", {
    select: "*",
    order_id: `eq.${orderId}`,
    order: "created_at.desc",
  });
}

export async function fetchBlockingOrderRefundByOrderId(
  admin: AdminClient,
  orderId: string,
): Promise<OrderRefundRow | null> {
  return await selectOne<OrderRefundRow>(admin, "order_refunds", {
    select: "*",
    order_id: `eq.${orderId}`,
    status: "in.(requesting,processing,success)",
    order: "created_at.desc",
  });
}
