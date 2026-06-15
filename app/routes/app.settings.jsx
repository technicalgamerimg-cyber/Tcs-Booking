import { useState, useCallback, useEffect } from "react";
import PropTypes from "prop-types";
import { useLoaderData, useFetcher, useRouteError, useRevalidator } from "react-router";
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
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  getTcsStatus,
  saveTcsCredentials,
  authenticateTcs,
  validateTcsInputs,
  saveDefaultCostCenter,
  getTcsCostCenters,
} from "../utils/tcs.server.js";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const status = await getTcsStatus(shop);
  const costCenters = await getTcsCostCenters(shop);

  if (!status) {
    return {
      connectionStatus: null,
      accessTokenExpiry: null,
      lastAuthAttempt: null,
      lastSuccessfulSync: null,
      lastApiMessage: null,
      hasCredentials: false,
      costCenterCode: "",
      tcsAccount: "",
      defaultInstructions: "",
      costCenters,
    };
  }

  return { ...status, costCenters };
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
    const tcsAccount = formData.get("tcsAccount") ?? "";

    // 1. Validate inputs — no DB/network calls if fields are invalid
    try {
      validateTcsInputs({ bearerToken, username, password, tcsAccount });
    } catch (err) {
      return { success: false, error: err.message, intent };
    }

    // 2. Save credentials to DB
    try {
      await saveTcsCredentials(shop, { bearerToken, username, password, tcsAccount });
    } catch (err) {
      return {
        success: false,
        error: `Failed to save credentials: ${err.message}`,
        intent,
      };
    }

    // 3. Authenticate with TCS
    let authResult;
    try {
      authResult = await authenticateTcs(shop);
    } catch (err) {
      return { success: false, error: err.message, intent };
    }

    if (!authResult.success) {
      return {
        success: false,
        error: `TCS authentication failed: ${authResult.message}`,
        intent,
      };
    }

    // 4. Auto-sync cities and cost centers immediately after successful auth
    try {
      const syncResult = await syncTcsData(shop, tcsAccount.trim());
      return {
        success: true,
        message: `Connected. Synced ${syncResult.citiesCount} cities and ${syncResult.costCentersCount} cost centers.`,
        intent,
      };
    } catch (syncErr) {
      // Auth succeeded — return success even if sync fails
      return {
        success: true,
        message: `Connected. (Data sync failed: ${syncErr.message})`,
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

  // ── Save Default Cost Center ─────────────────────────────────────────────
  if (intent === "save_defaults") {
    const costCenterCode = formData.get("costCenterCode") ?? "";
    const defaultInstructions = formData.get("defaultInstructions") ?? "";
    if (!costCenterCode) {
      return { success: false, error: "Please select a cost center.", intent };
    }
    try {
      await saveDefaultCostCenter(shop, { costCenterCode, defaultInstructions });
      return { success: true, message: "Default booking settings saved.", intent };
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
  const revalidator = useRevalidator();

  const [bearerToken, setBearerToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tcsAccount, setTcsAccount] = useState(loaderData.tcsAccount ?? "");
  const [defaultCostCenterCode, setDefaultCostCenterCode] = useState(loaderData.costCenterCode ?? "");
  const [defaultInstructions, setDefaultInstructions] = useState(loaderData.defaultInstructions ?? "");

  const [banner, setBanner] = useState(null); // { tone, title, message }

  const isSubmitting = fetcher.state !== "idle";
  const pendingIntent = fetcher.formData?.get("intent");

  // ── Watch for action results ─────────────────────────────────────────────
  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.success) {
      revalidator.revalidate();

      if (fetcher.data.intent === "save_defaults") {
        setBanner({ tone: "success", title: "Saved", message: fetcher.data.message });
      } else {
        const isConnect = fetcher.data.intent === "connect";
        setBanner({
          tone: "success",
          title: isConnect ? "Connected successfully" : "Connection test passed",
          message: fetcher.data.message ?? "success",
        });
        if (isConnect) {
          setBearerToken("");
          setUsername("");
          setPassword("");
        }
      }
    } else if (fetcher.data.error) {
      revalidator.revalidate();
      setBanner({
        tone: "critical",
        title: fetcher.data.intent === "connect" ? "Connection failed" : "Action failed",
        message: fetcher.data.error,
      });
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnect = useCallback(() => {
    setBanner(null);
    const formData = new FormData();
    formData.append("intent", "connect");
    formData.append("bearerToken", bearerToken);
    formData.append("username", username);
    formData.append("password", password);
    formData.append("tcsAccount", tcsAccount);
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher, bearerToken, username, password, tcsAccount]);

  const handleTest = useCallback(() => {
    setBanner(null);
    const formData = new FormData();
    formData.append("intent", "test");
    fetcher.submit(formData, { method: "POST" });
  }, [fetcher]);

  const handleSaveDefaults = useCallback(() => {
    setBanner(null);
    const fd = new FormData();
    fd.append("intent", "save_defaults");
    fd.append("costCenterCode", defaultCostCenterCode);
    fd.append("defaultInstructions", defaultInstructions);
    fetcher.submit(fd, { method: "POST" });
  }, [fetcher, defaultCostCenterCode, defaultInstructions]);

  const currentStatus = loaderData.connectionStatus;
  const currentExpiry = loaderData.accessTokenExpiry;
  const currentLastAuth = loaderData.lastAuthAttempt;
  const currentLastSync = loaderData.lastSuccessfulSync;
  const currentApiMessage = loaderData.lastApiMessage;
  const hasCredentials = loaderData.hasCredentials;

  const selectedCC = loaderData.costCenters.find(c => c.costCenterCode === defaultCostCenterCode);
  const costCenterPreview = selectedCC
    ? [selectedCC.costCenterName, selectedCC.phone, selectedCC.costCenterCity].filter(Boolean).join(" · ")
    : undefined;

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
              <FormLayout.Group>
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
              </FormLayout.Group>
              <TextField
                id="tcs-account-field"
                label="TCS Account Number"
                value={tcsAccount}
                onChange={setTcsAccount}
                autoComplete="off"
                helpText="e.g. 04011K1. Required to fetch your Cost Centers."
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

        {/* ── Default Booking Settings Card ──────────────────────────────── */}
        {hasCredentials && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Default Booking Settings
              </Text>
              <Text tone="subdued" as="p">
                Select which cost center's details (name, phone, address, city) to use as shipper info on every booking.
              </Text>
              <Divider />
              <Select
                label="Default Cost Center"
                options={[
                  { label: "Select a cost center", value: "" },
                  ...loaderData.costCenters.map(c => ({
                    label: `${c.costCenterName} (${c.costCenterCode}) — ${c.costCenterCity}`,
                    value: c.costCenterCode,
                  }))
                ]}
                value={defaultCostCenterCode}
                onChange={setDefaultCostCenterCode}
                helpText={costCenterPreview}
              />
              <TextField
                label="Default Booking Instructions"
                value={defaultInstructions}
                onChange={setDefaultInstructions}
                autoComplete="off"
                multiline={2}
                helpText='e.g. "Handle with care" or "Make call before delivery"'
              />
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={handleSaveDefaults}
                  loading={isSubmitting && pendingIntent === "save_defaults"}
                  disabled={isSubmitting || !defaultCostCenterCode}
                >
                  Save Default
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}

// ─── Shopify required exports ─────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
