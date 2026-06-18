import { authenticate } from "../shopify.server";
import { handlePrivacyWebhook } from "../utils/privacy-handlers.server";

export const action = async ({ request }) => {
  let webhook;

  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("[GDPR] privacy webhook authentication failed:", error?.message);
    return new Response("Unauthorized", { status: 401 });
  }

  return handlePrivacyWebhook(webhook);
};
