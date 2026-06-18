import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  // Nullify customer PII fields on the specified orders.
  // Business fields (consignment number, weights, amounts) are kept for audit purposes.
  const ordersToRedact = (payload.orders_to_redact ?? []).map(String);

  if (ordersToRedact.length > 0) {
    try {
      await db.order.updateMany({
        where: { shopifyNumericId: { in: ordersToRedact }, shop },
        data: {
          customerFirstName: null,
          customerLastName: null,
          customerPhone: null,
          shippingAddress1: null,
        },
      });
    } catch (err) {
      console.error(`[GDPR] customers/redact DB update failed for ${shop}:`, err.message);
      return new Response(null, { status: 500 });
    }
  }

  console.log(`[GDPR] customers/redact: anonymized ${ordersToRedact.length} orders for ${shop}`);
  return new Response();
};
