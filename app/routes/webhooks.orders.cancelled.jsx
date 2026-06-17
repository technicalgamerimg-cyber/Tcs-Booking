import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload } = await authenticate.webhook(request);

  try {
    await db.order.updateMany({
      where: { shopifyNumericId: String(payload.id) },
      data: { isCancelled: true, financialStatus: "cancelled" },
    });
  } catch (err) {
    console.error("[Webhook] orders/cancelled DB update failed:", err.message);
    return new Response(null, { status: 500 });
  }

  return new Response();
};
