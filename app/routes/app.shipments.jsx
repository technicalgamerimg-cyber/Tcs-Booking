import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useFetcher, useNavigate, useRevalidator, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Box,
  Text,
  Badge,
  Button,
  ButtonGroup,
  IndexTable,
  Modal,
  Banner,
  List,
  Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { cancelTcsShipment, bookTcsShipment, runInBatches, getDefaultCostCenterDetails } from "../utils/tcs.server.js";
import { cancelShopifyFulfillment, fulfillShopifyOrder } from "../utils/shopify.server.js";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") || "today";
  const status = url.searchParams.get("status") || "all";

  const now = Date.now();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

  const dateRanges = {
    today:     { gte: todayStart },
    yesterday: {
      gte: new Date(new Date(now - 86400000).setHours(0, 0, 0, 0)),
      lt:  todayStart,
    },
    last7:  { gte: new Date(now - 7 * 86400000) },
    last30: { gte: new Date(now - 30 * 86400000) },
  };

  const statusCondition =
    status === "booked"    ? { shipmentStatus: "BOOKED" }
    : status === "cancelled" ? { shipmentStatus: "CANCELLED" }
    : status === "failed"    ? { shipmentStatus: "CANCELLATION_FAILED" }
    : {};

  const shipments = await db.order.findMany({
    where: {
      shop,
      bookedAt: { not: null, ...(dateRanges[filter] ?? dateRanges.today) },
      ...statusCondition,
    },
    orderBy: { bookedAt: "desc" },
    take: 200,
    select: {
      id: true,
      name: true,
      customerFirstName: true,
      customerLastName: true,
      city: true,
      bookingWeight: true,
      bookingFreeCod: true,
      tcsConsignmentNo: true,
      shopifyFulfillmentId: true,
      bookedAt: true,
      shipmentStatus: true,
      isBooked: true,
      financialStatus: true,
      totalAmount: true,
      customerPhone: true,
      shippingAddress1: true,
      shopifyNumericId: true,
      productSummary: true,
      bookingInstructions: true,
    },
  });

  const totalCod    = shipments.reduce((s, o) => s + (parseFloat(o.bookingFreeCod) || 0), 0);
  const totalWeight = shipments.reduce((s, o) => s + (parseFloat(o.bookingWeight) || 0), 0);
  const failedCount = shipments.filter((o) => o.shipmentStatus === "CANCELLATION_FAILED").length;

  // CNs for last-24h loadsheet shortcut — BOOKED only
  const last24hCutoff = new Date(now - 86400000);
  const last24hRows = shipments.filter(
    (o) => o.bookedAt >= last24hCutoff && o.shipmentStatus === "BOOKED",
  );

  // Destination city codes for label generation
  const [costCenter, settingsRow] = await Promise.all([
    getDefaultCostCenterDetails(shop),
    db.tcsSettings.findUnique({ where: { shop }, select: { storeLogo: true } }),
  ]);

  let shipperCityCode = "";
  if (costCenter?.costCenterCity) {
    const row = await db.tcsCity.findFirst({
      where: { shop, cityName: costCenter.costCenterCity },
      select: { cityCode: true },
    });
    shipperCityCode = row?.cityCode || "";
  }

  const destCityNames = [...new Set(shipments.map((o) => o.city).filter(Boolean))];
  const cityCodes = destCityNames.length
    ? await db.tcsCity.findMany({
        where: { shop, cityName: { in: destCityNames } },
        select: { cityName: true, cityCode: true },
      })
    : [];
  const cityCodeMap = Object.fromEntries(
    cityCodes.map((c) => [c.cityName.toLowerCase(), c.cityCode]),
  );

  const loadsheetHistory = await db.loadsheetHistory.findMany({
    where: { shop },
    orderBy: { generatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      generatedAt: true,
      label: true,
      shipmentCount: true,
      totalCod: true,
      totalWeight: true,
      ordersSnapshot: true,
    },
  });

  return {
    shipments: shipments.map((s) => ({
      ...s,
      bookedAt: s.bookedAt?.toISOString() ?? null,
    })),
    filter,
    status,
    totalCod,
    totalWeight: Math.round(totalWeight * 100) / 100,
    totalCount: shipments.length,
    failedCount,
    last24hCount: last24hRows.length,
    last24hRows: last24hRows.map((s) => ({
      ...s,
      bookedAt: s.bookedAt?.toISOString() ?? null,
    })),
    costCenter: costCenter ?? null,
    shipperCityCode,
    cityCodeMap,
    storeLogo: settingsRow?.storeLogo ?? null,
    loadsheetHistory: loadsheetHistory.map((h) => ({
      ...h,
      generatedAt: h.generatedAt.toISOString(),
    })),
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  // ── Cancel single ──────────────────────────────────────────────────────
  if (intent === "cancel_single") {
    const orderId           = formData.get("orderId");
    const consignmentNo     = formData.get("consignmentNo");
    const shopifyFulfillmentId = formData.get("shopifyFulfillmentId") || null;

    // Step 1: cancel at TCS
    try {
      await cancelTcsShipment(shop, consignmentNo);
    } catch (err) {
      await db.order.update({
        where: { id: orderId },
        data: { shipmentStatus: "CANCELLATION_FAILED" },
      }).catch(() => {});
      return { success: false, error: `TCS cancel failed: ${err.message}`, intent };
    }

    // Step 2: cancel Shopify fulfillment if we have one
    if (shopifyFulfillmentId) {
      const fb = await cancelShopifyFulfillment(admin, shopifyFulfillmentId);
      if (!fb.success) {
        await db.order.update({
          where: { id: orderId },
          data: { shipmentStatus: "CANCELLATION_FAILED" },
        }).catch(() => {});
        return {
          success: false,
          error: `TCS cancelled but Shopify fulfillment cancel failed: ${fb.error}`,
          intent,
        };
      }
    }

    // Step 3: mark cancelled — preserve CN/bookedAt/fulfillmentId
    await db.order.update({
      where: { id: orderId },
      data: { shipmentStatus: "CANCELLED", isBooked: false },
    });

    return { success: true, intent, message: `CN ${consignmentNo} cancelled successfully.` };
  }

  // ── Cancel bulk ────────────────────────────────────────────────────────
  if (intent === "cancel_bulk") {
    const orderIds = formData.getAll("orderIds");
    const orders = await db.order.findMany({
      where: { id: { in: orderIds }, shop },
      select: { id: true, tcsConsignmentNo: true, shopifyFulfillmentId: true, name: true },
    });

    const results = await runInBatches(orders, 3, async (order) => {
      try {
        await cancelTcsShipment(shop, order.tcsConsignmentNo);
        if (order.shopifyFulfillmentId) {
          await cancelShopifyFulfillment(admin, order.shopifyFulfillmentId);
        }
        await db.order.update({
          where: { id: order.id },
          data: { shipmentStatus: "CANCELLED", isBooked: false },
        });
        return { name: order.name, success: true };
      } catch (err) {
        await db.order.update({
          where: { id: order.id },
          data: { shipmentStatus: "CANCELLATION_FAILED" },
        }).catch(() => {});
        return { name: order.name, success: false, error: err.message };
      }
    });

    const cancelled = results.filter((r) => r.status === "fulfilled" && r.value.success).length;
    const failed = results
      .map((r) => {
        if (r.status === "rejected") return { name: "unknown", error: r.reason.message };
        if (!r.value.success) return { name: r.value.name, error: r.value.error };
        return null;
      })
      .filter(Boolean);

    return { success: true, intent, cancelled, failed };
  }

  // ── Re-book cancelled order ────────────────────────────────────────────
  if (intent === "rebook") {
    const orderId = formData.get("orderId");
    const order = await db.order.findFirst({
      where: { id: orderId, shop },
      select: {
        id: true, shopifyNumericId: true, name: true,
        customerFirstName: true, customerLastName: true,
        customerPhone: true, city: true, shippingAddress1: true,
        financialStatus: true, totalAmount: true,
        bookingWeight: true, bookingInstructions: true, bookingFreeCod: true,
      },
    });

    if (!order) return { success: false, error: "Order not found.", intent };

    try {
      const { consignmentNo, remarks } = await bookTcsShipment(shop, order, {
        bookingWeight:       order.bookingWeight || "0.5",
        bookingInstructions: order.bookingInstructions || "",
        bookingFreeCod:      order.bookingFreeCod || "0",
      });

      // Shopify fulfillment write-back
      let shopifyFulfillmentId = null;
      try {
        const fb = await fulfillShopifyOrder(admin, order, consignmentNo);
        shopifyFulfillmentId = fb.fulfillmentId;
        if (fb.error) console.warn("[Rebook] Shopify fulfillment failed:", fb.error);
      } catch (fbErr) {
        console.error("[Rebook] Shopify write-back threw:", fbErr.message);
      }

      if (shopifyFulfillmentId) {
        await db.order
          .update({ where: { id: order.id }, data: { shopifyFulfillmentId } })
          .catch(() => {});
      }

      return {
        success: true,
        intent,
        message: `Re-booked as CN ${consignmentNo}.`,
        consignmentNo,
      };
    } catch (err) {
      return { success: false, error: err.message, intent };
    }
  }

  // ── Save loadsheet history ─────────────────────────────────────────────
  if (intent === "save_loadsheet_history") {
    const label      = formData.get("label") || "";
    const totalCod   = parseFloat(formData.get("totalCod")) || 0;
    const totalWeight = parseFloat(formData.get("totalWeight")) || 0;
    const rowsRaw    = formData.get("rows") || "[]";

    let rows;
    try { rows = JSON.parse(rowsRaw); } catch { rows = []; }

    const record = await db.loadsheetHistory.create({
      data: { shop, label, shipmentCount: rows.length, totalCod, totalWeight, ordersSnapshot: rowsRaw },
    });

    return {
      success: true,
      intent: "save_loadsheet_history",
      generatedAt: record.generatedAt.toISOString(),
      rows,
    };
  }

  return { success: false, error: "Unknown intent.", intent };
};

// ─── Component ────────────────────────────────────────────────────────────────

const DATE_TABS = [
  { id: "today",     content: "Today" },
  { id: "yesterday", content: "Yesterday" },
  { id: "last7",     content: "Last 7 Days" },
  { id: "last30",    content: "Last 30 Days" },
];

const STATUS_TABS = [
  { id: "all",       content: "All" },
  { id: "booked",    content: "Booked" },
  { id: "cancelled", content: "Cancelled" },
  { id: "failed",    content: "Failed" },
];

function statusBadge(shipmentStatus) {
  if (shipmentStatus === "CANCELLED")          return <Badge tone="subdued">Cancelled</Badge>;
  if (shipmentStatus === "CANCELLATION_FAILED") return <Badge tone="warning">Failed ⚠</Badge>;
  return <Badge tone="success">Booked</Badge>;
}

export default function Shipments() {
  const {
    shipments, filter, status, totalCod, totalWeight, totalCount, failedCount,
    last24hCount, last24hRows, costCenter, shipperCityCode, cityCodeMap, storeLogo,
    loadsheetHistory,
  } = useLoaderData();

  const fetcher         = useFetcher();
  const historyFetcher  = useFetcher();
  const navigate        = useNavigate();
  const revalidator     = useRevalidator();
  const shopify         = useAppBridge();

  const [selectedIds, setSelectedIds]         = useState([]);
  const [cancelModal, setCancelModal]         = useState(false);
  const [cancelTargets, setCancelTargets]     = useState([]); // [{ id, name, cn, fulfillmentId }]
  const [actionResult, setActionResult]       = useState(null);
  const [loadsheetSaving, setLoadsheetSaving] = useState(false);

  const isSubmitting = fetcher.state !== "idle";

  const dateTabIdx   = DATE_TABS.findIndex((t) => t.id === filter);
  const statusTabIdx = STATUS_TABS.findIndex((t) => t.id === status);

  const handleDateTab = useCallback(
    (idx) => navigate(`/app/shipments?filter=${DATE_TABS[idx].id}&status=${status}`),
    [navigate, status],
  );
  const handleStatusTab = useCallback(
    (idx) => navigate(`/app/shipments?filter=${filter}&status=${STATUS_TABS[idx].id}`),
    [navigate, filter],
  );

  const openLabel = useCallback(
    async (orders) => {
      if (!costCenter) {
        shopify.toast.show("No cost center configured.", { isError: true });
        return;
      }
      const targets = Array.isArray(orders) ? orders : [orders];
      try {
        const { openTcsLabel } = await import("../components/label/openTcsLabel.client.js");
        await openTcsLabel(targets, costCenter, { shipperCityCode, cityCodeMap, storeLogo });
      } catch (err) {
        shopify.toast.show(err.message || "Label failed.", { isError: true });
      }
    },
    [costCenter, shipperCityCode, cityCodeMap, storeLogo, shopify],
  );

  // After history is saved, the server returns the rows + generatedAt — generate PDF then
  useEffect(() => {
    const data = historyFetcher.data;
    if (!data || data.intent !== "save_loadsheet_history" || !data.rows) return;
    import("../components/loadsheet/openLoadsheet.client.js")
      .then(({ openLoadsheetPdf }) => openLoadsheetPdf(data.rows, data.generatedAt))
      .catch((err) => shopify.toast.show(err.message || "Loadsheet failed.", { isError: true }))
      .finally(() => { setLoadsheetSaving(false); revalidator.revalidate(); });
  }, [historyFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const openLoadsheet = useCallback(
    (rows, label) => {
      if (!rows.length) {
        shopify.toast.show("No booked shipments to export.", { isError: true });
        return;
      }
      if (loadsheetSaving) return;
      setLoadsheetSaving(true);

      // Keep only PDF-relevant fields to minimise snapshot size
      const snapshot = rows.map((r) => ({
        id: r.id,
        name: r.name,
        tcsConsignmentNo: r.tcsConsignmentNo,
        customerFirstName: r.customerFirstName,
        customerLastName: r.customerLastName,
        city: r.city,
        bookingWeight: r.bookingWeight,
        bookingFreeCod: r.bookingFreeCod,
        bookedAt: r.bookedAt,
        shipmentStatus: r.shipmentStatus,
      }));

      const totalCodVal    = snapshot.reduce((s, r) => s + (parseFloat(r.bookingFreeCod) || 0), 0);
      const totalWeightVal = snapshot.reduce((s, r) => s + (parseFloat(r.bookingWeight) || 0), 0);

      const fd = new FormData();
      fd.append("intent", "save_loadsheet_history");
      fd.append("label", label || `${filter} · ${status}`);
      fd.append("totalCod", String(totalCodVal));
      fd.append("totalWeight", String(totalWeightVal));
      fd.append("rows", JSON.stringify(snapshot));
      historyFetcher.submit(fd, { method: "POST" });
    },
    [historyFetcher, filter, status, shopify, loadsheetSaving],
  );

  const downloadHistory = useCallback(
    async (entry) => {
      try {
        const rows = JSON.parse(entry.ordersSnapshot);
        const { openLoadsheetPdf } = await import("../components/loadsheet/openLoadsheet.client.js");
        await openLoadsheetPdf(rows, entry.generatedAt);
      } catch (err) {
        shopify.toast.show(err.message || "Download failed.", { isError: true });
      }
    },
    [shopify],
  );

  const confirmCancel = useCallback(
    (targets) => {
      setCancelTargets(targets);
      setCancelModal(true);
    },
    [],
  );

  const submitCancel = useCallback(() => {
    setCancelModal(false);
    const fd = new FormData();
    if (cancelTargets.length === 1) {
      fd.append("intent", "cancel_single");
      fd.append("orderId", cancelTargets[0].id);
      fd.append("consignmentNo", cancelTargets[0].cn);
      if (cancelTargets[0].fulfillmentId) {
        fd.append("shopifyFulfillmentId", cancelTargets[0].fulfillmentId);
      }
    } else {
      fd.append("intent", "cancel_bulk");
      cancelTargets.forEach((t) => fd.append("orderIds", t.id));
    }
    fetcher.submit(fd, { method: "POST" });
  }, [cancelTargets, fetcher]);

  const submitRebook = useCallback(
    (orderId) => {
      fetcher.submit({ intent: "rebook", orderId }, { method: "POST" });
    },
    [fetcher],
  );

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;

    if (data.success) {
      setSelectedIds([]);
      setActionResult(data);
      revalidator.revalidate();
    } else if (data.error) {
      shopify.toast.show(data.error, { isError: true });
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const bookableIds = shipments
    .filter((s) => s.shipmentStatus === "BOOKED")
    .map((s) => s.id);

  const allSelected =
    bookableIds.length > 0 && selectedIds.length === bookableIds.length;

  const handleSelection = useCallback(
    (type, isSelected, selection) => {
      if (type === "all" || type === "page") {
        setSelectedIds(isSelected ? [...bookableIds] : []);
      } else if (type === "single") {
        setSelectedIds((prev) =>
          isSelected ? [...prev, selection] : prev.filter((id) => id !== selection),
        );
      }
    },
    [bookableIds],
  );

  const selectedShipments = shipments.filter(
    (s) => selectedIds.includes(s.id) && s.shipmentStatus === "BOOKED",
  );

  const promotedBulkActions = selectedIds.length
    ? [
        {
          content: `Print labels (${selectedIds.length})`,
          onAction: () => openLabel(selectedShipments.filter((s) => s.tcsConsignmentNo)),
        },
        {
          content: `Cancel selected (${selectedIds.length})`,
          onAction: () =>
            confirmCancel(
              selectedShipments.map((s) => ({
                id: s.id,
                name: s.name,
                cn: s.tcsConsignmentNo,
                fulfillmentId: s.shopifyFulfillmentId,
              })),
            ),
          destructive: true,
        },
        {
          content: `Print loadsheet (${selectedIds.length})`,
          onAction: () => openLoadsheet(
            selectedShipments,
            `Selected (${selectedShipments.length}) · ${new Date().toLocaleDateString("en-PK", { day: "2-digit", month: "short" })}`,
          ),
        },
      ]
    : undefined;

  const rowMarkup = shipments.map((s, index) => {
    const fullName =
      [s.customerFirstName, s.customerLastName].filter(Boolean).join(" ") || "—";
    const cod = parseFloat(s.bookingFreeCod) || 0;
    const wt  = parseFloat(s.bookingWeight) || 0;
    const bookedDate = s.bookedAt
      ? new Date(s.bookedAt).toLocaleDateString("en-PK", { day: "2-digit", month: "short" })
      : "—";

    const isCancelled = s.shipmentStatus !== "BOOKED";

    return (
      <IndexTable.Row
        id={s.id}
        key={s.id}
        position={index}
        selected={selectedIds.includes(s.id)}
        disabled={isCancelled}
      >
        <IndexTable.Cell>
          <Text variant="bodySm" as="span">{s.tcsConsignmentNo || "—"}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="semibold" as="span">{s.name}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{fullName}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{s.city || "—"}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{wt.toFixed(2)} kg</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {cod > 0
            ? <Badge tone="attention">Rs {cod.toLocaleString()}</Badge>
            : <Text tone="subdued" as="span">—</Text>}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text tone="subdued" as="span">{bookedDate}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>{statusBadge(s.shipmentStatus)}</IndexTable.Cell>
        <IndexTable.Cell>
          <ButtonGroup>
            {s.shipmentStatus === "BOOKED" && (
              <Button
                size="slim"
                tone="critical"
                loading={isSubmitting && fetcher.formData?.get("orderId") === s.id}
                onClick={() =>
                  confirmCancel([{
                    id: s.id,
                    name: s.name,
                    cn: s.tcsConsignmentNo,
                    fulfillmentId: s.shopifyFulfillmentId,
                  }])
                }
              >
                Cancel
              </Button>
            )}
            {(s.shipmentStatus === "CANCELLED" || s.shipmentStatus === "CANCELLATION_FAILED") && (
              <Button
                size="slim"
                loading={isSubmitting && fetcher.formData?.get("orderId") === s.id}
                onClick={() => submitRebook(s.id)}
              >
                Re-book
              </Button>
            )}
          </ButtonGroup>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Shipments"
      primaryAction={{
        content: "Loadsheet (last 24h)",
        disabled: last24hCount === 0 || loadsheetSaving,
        loading: loadsheetSaving,
        onAction: () => openLoadsheet(last24hRows, `Last 24h · ${new Date().toLocaleDateString("en-PK", { day: "2-digit", month: "short" })}`),
      }}
      secondaryActions={[
        {
          content: "Print all labels",
          disabled: !shipments.some((s) => s.shipmentStatus === "BOOKED"),
          onAction: () =>
            openLabel(shipments.filter((s) => s.shipmentStatus === "BOOKED" && s.tcsConsignmentNo)),
        },
      ]}
    >
      <BlockStack gap="400">
        {/* Action result banner */}
        {actionResult && (
          <Banner
            tone={
              actionResult.intent === "cancel_bulk" && actionResult.failed?.length
                ? "warning"
                : "success"
            }
            title={
              actionResult.intent === "cancel_single"
                ? actionResult.message
                : actionResult.intent === "cancel_bulk"
                ? `Cancelled ${actionResult.cancelled}${actionResult.failed?.length ? `, ${actionResult.failed.length} failed` : ""}`
                : actionResult.message
            }
            onDismiss={() => setActionResult(null)}
          >
            {actionResult.failed?.length > 0 && (
              <List>
                {actionResult.failed.map((f, i) => (
                  <List.Item key={i}>{f.name} — {f.error}</List.Item>
                ))}
              </List>
            )}
          </Banner>
        )}

        {/* Stats */}
        <InlineGrid columns={4} gap="300">
          <Card>
            <BlockStack gap="100">
              <Text tone="subdued" as="p" variant="bodySm">Total</Text>
              <Text variant="headingMd" as="p">{totalCount}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text tone="subdued" as="p" variant="bodySm">COD</Text>
              <Text variant="headingMd" as="p">Rs {totalCod.toLocaleString()}</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text tone="subdued" as="p" variant="bodySm">Weight</Text>
              <Text variant="headingMd" as="p">{totalWeight} kg</Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text tone="subdued" as="p" variant="bodySm">Failed</Text>
              <Text variant="headingMd" as="p" tone={failedCount ? "critical" : undefined}>
                {failedCount}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        {/* Date filter tabs */}
        <Card padding="0">
          <Tabs
            tabs={DATE_TABS}
            selected={dateTabIdx >= 0 ? dateTabIdx : 0}
            onSelect={handleDateTab}
            fitted
          />
        </Card>

        {/* Status filter tabs */}
        <Card padding="0">
          <Tabs
            tabs={STATUS_TABS}
            selected={statusTabIdx >= 0 ? statusTabIdx : 0}
            onSelect={handleStatusTab}
            fitted
          />
        </Card>

        {/* Last-24h loadsheet shortcut */}
        {last24hCount > 0 && (
          <Banner tone="info">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span">{last24hCount} consignment{last24hCount !== 1 ? "s" : ""} booked in the last 24 hours</Text>
              <Button
                variant="plain"
                loading={loadsheetSaving}
                disabled={loadsheetSaving}
                onClick={() => openLoadsheet(last24hRows, `Last 24h · ${new Date().toLocaleDateString("en-PK", { day: "2-digit", month: "short" })}`)}
              >
                Download Loadsheet PDF
              </Button>
            </InlineStack>
          </Banner>
        )}

        {/* Table */}
        {shipments.length === 0 ? (
          <Card>
            <Box paddingBlock="1600">
              <Text alignment="center" tone="subdued" as="p">
                No shipments found for this filter.
              </Text>
            </Box>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "shipment", plural: "shipments" }}
              itemCount={shipments.length}
              selectedItemsCount={allSelected ? "All" : selectedIds.length}
              onSelectionChange={handleSelection}
              promotedBulkActions={promotedBulkActions}
              headings={[
                { title: "CN #" },
                { title: "Order" },
                { title: "Customer" },
                { title: "City" },
                { title: "Weight" },
                { title: "COD" },
                { title: "Booked" },
                { title: "Status" },
                { title: "Actions" },
              ]}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        )}

        {/* Loadsheet History */}
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">Loadsheet History</Text>
            {loadsheetHistory.length === 0 ? (
              <Box paddingBlock="400">
                <Text tone="subdued" as="p">No loadsheets generated yet. Generate one above to see it here.</Text>
              </Box>
            ) : (
              <IndexTable
                resourceName={{ singular: "loadsheet", plural: "loadsheets" }}
                itemCount={loadsheetHistory.length}
                selectable={false}
                headings={[
                  { title: "Generated" },
                  { title: "Label" },
                  { title: "Shipments" },
                  { title: "COD" },
                  { title: "Weight" },
                  { title: "" },
                ]}
              >
                {loadsheetHistory.map((h, i) => (
                  <IndexTable.Row id={h.id} key={h.id} position={i}>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {new Date(h.generatedAt).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" })}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{h.label || "—"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{h.shipmentCount}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">Rs {h.totalCod.toLocaleString()}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{h.totalWeight.toFixed(2)} kg</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button size="slim" onClick={() => downloadHistory(h)}>Download</Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* Cancel confirmation modal */}
      <Modal
        open={cancelModal}
        onClose={() => setCancelModal(false)}
        title={cancelTargets.length === 1 ? `Cancel CN ${cancelTargets[0]?.cn}?` : `Cancel ${cancelTargets.length} shipments?`}
        primaryAction={{
          content: "Confirm Cancel",
          destructive: true,
          loading: isSubmitting,
          onAction: submitCancel,
        }}
        secondaryActions={[{ content: "Go back", onAction: () => setCancelModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">This will cancel at TCS and reverse the Shopify fulfillment. The booking record is preserved for audit.</Text>
            {cancelTargets.length > 1 && (
              <List>
                {cancelTargets.map((t) => (
                  <List.Item key={t.id}>{t.name} — {t.cn}</List.Item>
                ))}
              </List>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);



