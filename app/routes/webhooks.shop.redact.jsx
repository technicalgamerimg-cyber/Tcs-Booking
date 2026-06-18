import { authenticate } from "../shopify.server";
import { handleShopRedact } from "../utils/privacy-handlers.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);
  return handleShopRedact(payload, shop);
};
