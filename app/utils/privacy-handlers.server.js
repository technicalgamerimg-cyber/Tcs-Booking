import db from "../db.server";

export async function handleDataRequest(payload, shop) {
  console.log(
    `[GDPR] customers/data_request acknowledged for customer ${payload.customer?.id ?? "unknown"} at ${shop}`,
  );

  return new Response(null, { status: 200 });
}

export async function handleCustomerRedact(payload, shop) {
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
  return new Response(null, { status: 200 });
}

export async function handleShopRedact(_payload, shop) {
  try {
    await db.$transaction([
      db.session.deleteMany({ where: { shop } }),
      db.order.deleteMany({ where: { shop } }),
      db.tcsSettings.deleteMany({ where: { shop } }),
      db.tcsCity.deleteMany({ where: { shop } }),
      db.tcsCostCenter.deleteMany({ where: { shop } }),
      db.loadsheetHistory.deleteMany({ where: { shop } }),
      db.auditLog.deleteMany({ where: { shop } }),
    ]);
  } catch (err) {
    console.error(`[GDPR] shop/redact DB deletion failed for ${shop}:`, err.message);
    return new Response(null, { status: 500 });
  }

  console.log(`[GDPR] shop/redact: all data deleted for ${shop}`);
  return new Response(null, { status: 200 });
}

export async function handlePrivacyWebhook({ topic, payload, shop }) {
  const normalizedTopic = topic?.toUpperCase().replaceAll("/", "_");

  switch (normalizedTopic) {
    case "CUSTOMERS_DATA_REQUEST":
      return handleDataRequest(payload, shop);
    case "CUSTOMERS_REDACT":
      return handleCustomerRedact(payload, shop);
    case "SHOP_REDACT":
      return handleShopRedact(payload, shop);
    default:
      console.warn(`[GDPR] Unsupported privacy webhook topic: ${topic ?? "unknown"}`);
      return new Response(null, { status: 400 });
  }
}
