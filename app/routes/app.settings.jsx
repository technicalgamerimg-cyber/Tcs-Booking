import { useState, useCallback, useEffect } from "react";
import PropTypes from "prop-types";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  TextField,
  FormLayout,
  Banner,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getTcsStatus,
  saveTcsCredentials,
  authenticateTcs,
  validateTcsInputs,
} from "../utils/tcs.server.js";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const status = await getTcsStatus(shop);

  // If no record exists, return safe defaults
  if (!status) {
    return {
      status: null,
      accessTokenExpiry: null,
      lastAuthAttempt: null,
      lastSuccessfulSync: null,
      lastApiMessage: null,
      hasCredentials: false,
    };
  }

  return status;
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Connect API ──────────────────────────────────────────────────────────
  if (intent === "connect") {
    const bearerToken = formData.get("bearerToken") ?? "";
    const username = formData.get("username") ?? "";
    const password = formData.get("password") ?? "";

    // 1. Validate inputs — no DB/network calls if fields are invalid
    try {
      validateTcsInputs({ bearerToken, username, password });
    } catch (err) {
      return { success: false, error: err.message, intent };
    }

    // 2. Save credentials to DB
    try {
      await saveTcsCredentials(shop, { bearerToken, username, password });
    } catch (err) {
      return {
        success: false,
        error: `Failed to save credentials: ${err.message}`,
        intent,
      };
    }

    // 3. Authenticate with TCS
    try {
      const result = await authenticateTcs(shop);
      return {
        success: result.success,
        message: result.message,
        error: result.success ? null : `TCS authentication failed: ${result.message}`,
        intent,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        intent,
      };
    }
  }

  // ── Test Connection ──────────────────────────────────────────────────────
  if (intent === "test") {
    try {
      const result = await authenticateTcs(shop);
      return {
        success: result.success,
        message: result.message,
        error: result.success ? null : `Connection test failed: ${result.message}`,
        intent,
      };
    } catch (err) {
      return { success: false, error: err.message, intent };
    }
  }

  return { success: false, error: "Unknown action", intent };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(isoString) {
  if (!isoString) return "—";
  try {
    return new Date(isoString).toLocaleString("en-GB", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return isoString;
  }
}

function StatusBadge({ status }) {
  if (!status || status === "disconnected") {
    return <Badge tone="warning">Disconnected</Badge>;
  }
  if (status === "connected") {
    return <Badge tone="success">Connected ✓</Badge>;
  }
  if (status === "error") {
    return <Badge tone="critical">Error</Badge>;
  }
  return <Badge>{status}</Badge>;
}

StatusBadge.propTypes = {
  status: PropTypes.string,
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Settings() {
  const loaderData = useLoaderData();
  const fetcher = useFetcher();

  const [bearerToken, setBearerToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [banner, setBanner] = useState(null); // { tone, title, message }

  const isSubmitting = fetcher.state !== "idle";
  const pendingIntent = fetcher.formData?.get("intent");

  // ── Watch for action results ─────────────────────────────────────────────
  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success) {
      const isConnect = fetcher.data.intent === "connect";
      setBanner({
        tone: "success",
        title: isConnect ? "Connected successfully" : "Connection test passed",
        message: `TCS API responded: ${fetcher.data.message ?? "success"}`,
      });
      // Clear form fields after successful connect
      if (isConnect) {
        setBearerToken("");
        setUsername("");
        setPassword("");
      }
    } else if (fetcher.data.error) {
      setBanner({
        tone: "critical",
        title: fetcher.data.intent === "connect" ? "Connection failed" : "Test failed",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]);

  const handleConnect = useCallback(() => {
    setBanner(null);
    const formData = new FormData();
    formData.append("intent", "connect");
    formData.append("bearerToken", bearerToken);
    formData.append("username", username);
    formData.append("password", password);
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher, bearerToken, username, password]);

  const handleTest = useCallback(() => {
    setBanner(null);
    const formData = new FormData();
    formData.append("intent", "test");
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher]);

  // Use fresh loader data if available (re-fetched after action)
  const currentStatus = loaderData.status;
  const currentExpiry = loaderData.accessTokenExpiry;
  const currentLastAuth = loaderData.lastAuthAttempt;
  const currentLastSync = loaderData.lastSuccessfulSync;
  const currentApiMessage = loaderData.lastApiMessage;
  const hasCredentials = loaderData.hasCredentials;

  return (
    <Page
      title="TCS Courier — Integration Settings"
      subtitle="Connect your TCS account to enable automated shipment booking and tracking"
      backAction={{ content: "Orders", url: "/app" }}
    >
      <BlockStack gap="500">
        {/* Result banner */}
        {banner && (
          <Banner
            tone={banner.tone}
            title={banner.title}
            onDismiss={() => setBanner(null)}
          >
            <p>{banner.message}</p>
          </Banner>
        )}

        {/* ── Connection Status Card ─────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              Connection Status
            </Text>
            <Divider />

            <BlockStack gap="300">
              {/* Status row */}
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" as="span">
                  Status
                </Text>
                <StatusBadge status={currentStatus} />
              </InlineStack>

              {/* Token expiry */}
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" as="span">
                  Token Expiry
                </Text>
                <Text as="span">{formatDateTime(currentExpiry)}</Text>
              </InlineStack>

              {/* Last successful sync */}
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" as="span">
                  Last Successful Sync
                </Text>
                <Text as="span">{formatDateTime(currentLastSync)}</Text>
              </InlineStack>

              {/* Last auth attempt */}
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" as="span">
                  Last Auth Attempt
                </Text>
                <Text as="span">{formatDateTime(currentLastAuth)}</Text>
              </InlineStack>

              {/* API message */}
              <InlineStack align="space-between" blockAlign="center">
                <Text tone="subdued" as="span">
                  Last API Message
                </Text>
                <Text as="span">{currentApiMessage ?? "—"}</Text>
              </InlineStack>
            </BlockStack>

            {/* Test Connection button — only if credentials exist */}
            {hasCredentials && (
              <Box paddingBlockStart="200">
                <Button
                  id="test-connection-btn"
                  onClick={handleTest}
                  loading={isSubmitting && pendingIntent === "test"}
                  disabled={isSubmitting}
                >
                  Test Connection
                </Button>
              </Box>
            )}
          </BlockStack>
        </Card>

        {/* ── TCS Credentials Card ───────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              TCS Credentials
            </Text>
            <Text tone="subdued" as="p">
              {hasCredentials
                ? "Your credentials are saved. Enter new values below to update them."
                : "Enter your TCS API credentials to get started."}
            </Text>
            <Divider />

            <FormLayout>
              <TextField
                id="bearer-token-field"
                label="Bearer Token"
                type="password"
                value={bearerToken}
                onChange={setBearerToken}
                autoComplete="off"
                placeholder={hasCredentials ? "Leave blank to keep existing token" : ""}
                helpText="Your TCS-issued API bearer token"
              />
              <TextField
                id="username-field"
                label="Username"
                value={username}
                onChange={setUsername}
                autoComplete="username"
                placeholder={hasCredentials ? "Leave blank to keep existing username" : ""}
                helpText="Your TCS account username"
              />
              <TextField
                id="password-field"
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                placeholder={hasCredentials ? "Leave blank to keep existing password" : ""}
                helpText="Your TCS account password"
              />
            </FormLayout>

            <InlineStack gap="300">
              <Button
                id="connect-api-btn"
                variant="primary"
                onClick={handleConnect}
                loading={isSubmitting && pendingIntent === "connect"}
                disabled={isSubmitting}
              >
                {hasCredentials ? "Update & Reconnect" : "Connect API"}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

// ─── Shopify required exports ─────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
