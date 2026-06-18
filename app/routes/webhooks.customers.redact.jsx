import { authenticate } from "../shopify.server";
import { handleCustomerRedact } from "../utils/privacy-handlers.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  return handleCustomerRedact(payload, shop);
};
