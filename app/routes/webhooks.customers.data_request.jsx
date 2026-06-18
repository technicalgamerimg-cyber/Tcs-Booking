import { authenticate } from "../shopify.server";
import { handleDataRequest } from "../utils/privacy-handlers.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  return handleDataRequest(payload, shop);
};
