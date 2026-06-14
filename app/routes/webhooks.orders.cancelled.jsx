import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload } = await authenticate.webhook(request);

  await db.order.updateMany({
    where: { shopifyNumericId: String(payload.id) },
    data: { isCancelled: true, financialStatus: "cancelled" },
  });

  return new Response();
};
