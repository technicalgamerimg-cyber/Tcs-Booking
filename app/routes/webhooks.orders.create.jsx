import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizePaymentStatus } from "../utils/orderStatus";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  const numericId = String(payload.id);
  const gid = payload.admin_graphql_api_id;

  await db.order.upsert({
    where: { shopifyNumericId: numericId },
    create: {
      id: gid,
      shopifyNumericId: numericId,
      shop,
      name: payload.name ?? `#${numericId}`,
      customerFirstName: payload.customer?.first_name ?? null,
      customerLastName: payload.customer?.last_name ?? null,
      customerPhone: payload.customer?.phone ?? null,
      totalAmount: payload.total_price ?? "0",
      currencyCode: payload.currency ?? "",
      city: payload.shipping_address?.city ?? null,
      financialStatus: normalizePaymentStatus(payload.financial_status),
      fulfillmentStatus: payload.fulfillment_status ?? null,
      shopifyCreatedAt: payload.created_at ? new Date(payload.created_at) : null,
      ...(payload.fulfillment_status?.toLowerCase() === "fulfilled"
        ? { isBooked: true }
        : {}),
    },
    update: {
      name: payload.name ?? `#${numericId}`,
      customerFirstName: payload.customer?.first_name ?? null,
      customerLastName: payload.customer?.last_name ?? null,
      customerPhone: payload.customer?.phone ?? null,
      totalAmount: payload.total_price ?? "0",
      currencyCode: payload.currency ?? "",
      city: payload.shipping_address?.city ?? null,
      financialStatus: normalizePaymentStatus(payload.financial_status),
      fulfillmentStatus: payload.fulfillment_status ?? null,
      ...(payload.fulfillment_status?.toLowerCase() === "fulfilled"
        ? { isBooked: true }
        : {}),
    },
  });

  return new Response();
};
