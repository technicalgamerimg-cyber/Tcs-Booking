import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));

  return {
    errors,
  };
};

export default function Auth() {
  const loaderData = useLoaderData();

  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="TCS Booking">
          <s-text>
            Please install TCS Booking from the Shopify App Store to get started.
          </s-text>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
