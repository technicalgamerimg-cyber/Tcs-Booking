import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  // Shopify requires acknowledgement — no obligation to transmit data back.
  // This app stores customer PII only in the Order table (name, phone, address).
  // A data export pipeline can be added here if required by your privacy policy.
  console.log(`[GDPR] customers/data_request for customer ${payload.customer?.id} at ${shop}`);
  return new Response();
};
