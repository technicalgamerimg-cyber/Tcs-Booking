import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizePaymentStatus } from "../utils/orderStatus";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  const numericId = String(payload.id);
  const gid = payload.admin_graphql_api_id;

  const lineItems = payload.line_items ?? [];
  const productSummary = lineItems.length
    ? lineItems
        .map((item) => {
          const sku = item.sku ? `[${item.sku}] ` : "";
          return `${sku}${item.title} x${item.quantity}`;
        })
        .join(", ")
        .slice(0, 500)
    : null;

  try {
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
        shippingAddress1: payload.shipping_address?.address1 ?? null,
        financialStatus: normalizePaymentStatus(payload.financial_status),
        fulfillmentStatus: payload.fulfillment_status ?? null,
        shopifyCreatedAt: payload.created_at ? new Date(payload.created_at) : null,
        productSummary,
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
        shippingAddress1: payload.shipping_address?.address1 ?? null,
        financialStatus: normalizePaymentStatus(payload.financial_status),
        fulfillmentStatus: payload.fulfillment_status ?? null,
        productSummary,
        ...(payload.fulfillment_status?.toLowerCase() === "fulfilled"
          ? { isBooked: true }
          : {}),
      },
    });
  } catch (err) {
    console.error("[Webhook] orders/create DB upsert failed:", err.message);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
