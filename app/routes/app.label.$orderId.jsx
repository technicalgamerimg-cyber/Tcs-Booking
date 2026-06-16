import { authenticate } from "../shopify.server";
import db from "../db.server.js";
import { getTcsLabel } from "../utils/tcs.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const order = await db.order.findFirst({
    where: { shopifyNumericId: String(params.orderId), shop },
    select: { tcsConsignmentNo: true },
  });

  if (!order?.tcsConsignmentNo) {
    throw new Response("No TCS label available for this order.", { status: 404 });
  }

  const result = await getTcsLabel(shop, order.tcsConsignmentNo);

  if (result.type === "url") {
    return Response.redirect(result.url, 302);
  }

  return new Response(result.data, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${order.tcsConsignmentNo}.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  });
};
