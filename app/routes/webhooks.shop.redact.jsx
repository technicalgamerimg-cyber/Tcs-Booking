import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop } = await authenticate.webhook(request);

  // Shopify calls this 48 hours after a merchant uninstalls the app.
  // Delete all data stored for this shop across every table.
  try {
    await db.$transaction([
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
  return new Response();
};
