import { useState, useCallback, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, useRouteError, useRevalidator, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Badge,
  Button,
  ButtonGroup,
  TextField,
  IndexTable,
  Modal,
  FormLayout,
  Banner,
  List,
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizePaymentStatus } from "../utils/orderStatus";
import { bookTcsShipment, bookTcsShipmentBulk, runInBatches, getDefaultCostCenterDetails } from "../utils/tcs.server.js";
import { fulfillShopifyOrder } from "../utils/shopify.server.js";

const PAGE_SIZE = 50;

const FETCH_ORDERS_QUERY = `#graphql
  query FetchOrders($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          customer { firstName lastName phone }
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { city address1 }
          displayFinancialStatus
          displayFulfillmentStatus
          createdAt
          lineItems(first: 10) {
            edges {
              node { title sku quantity }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Loader: fetch from Shopify → save to DB → return from DB ────────────────

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  let syncError = null;
  try {
    const response = await admin.graphql(FETCH_ORDERS_QUERY, {
      variables: { first: PAGE_SIZE, after: null },
    });
    const json = await response.json();

    if (json.errors) {
      const msgs = json.errors.map((e) => e.message).join(", ");
      console.error("Orders GraphQL errors:", msgs);
      syncError = msgs;
    }

    const edges = json.data?.orders?.edges ?? [];

    await Promise.allSettled(
      edges.map(async ({ node }) => {
        const numericId = node.id.replace("gid://shopify/Order/", "");
        const lineItems = node.lineItems?.edges?.map((e) => e.node) ?? [];
        const productSummary = lineItems.length
          ? lineItems
              .map((item) => {
                const sku = item.sku ? `[${item.sku}] ` : "";
                return `${sku}${item.title} x${item.quantity}`;
              })
              .join(", ")
              .slice(0, 500)
          : null;

        await db.order.upsert({
          where: { shopifyNumericId: numericId },
          create: {
            id: node.id,
            shopifyNumericId: numericId,
            shop,
            name: node.name,
            customerFirstName: node.customer?.firstName ?? null,
            customerLastName: node.customer?.lastName ?? null,
            customerPhone: node.customer?.phone ?? null,
            totalAmount: node.totalPriceSet?.shopMoney?.amount ?? "0",
            currencyCode: node.totalPriceSet?.shopMoney?.currencyCode ?? "",
            city: node.shippingAddress?.city ?? null,
            shippingAddress1: node.shippingAddress?.address1 ?? null,
            financialStatus: normalizePaymentStatus(node.displayFinancialStatus),
            fulfillmentStatus: node.displayFulfillmentStatus ?? null,
            shopifyCreatedAt: node.createdAt ? new Date(node.createdAt) : null,
            productSummary,
            ...(node.displayFulfillmentStatus?.toUpperCase() === "FULFILLED"
              ? { isBooked: true }
              : {}),
          },
          update: {
            name: node.name,
            customerFirstName: node.customer?.firstName ?? null,
            customerLastName: node.customer?.lastName ?? null,
            customerPhone: node.customer?.phone ?? null,
            totalAmount: node.totalPriceSet?.shopMoney?.amount ?? "0",
            currencyCode: node.totalPriceSet?.shopMoney?.currencyCode ?? "",
            city: node.shippingAddress?.city ?? null,
            shippingAddress1: node.shippingAddress?.address1 ?? null,
            financialStatus: normalizePaymentStatus(node.displayFinancialStatus),
            fulfillmentStatus: node.displayFulfillmentStatus ?? null,
            productSummary,
            ...(node.displayFulfillmentStatus?.toUpperCase() === "FULFILLED"
              ? { isBooked: true }
              : {}),
          },
        });
      }),
    );
  } catch (err) {
    const msg =
      err?.graphQLErrors?.map((e) => e.message).join(", ") ??
      err?.message ??
      "Unknown error";
    console.error("Orders sync failed:", msg);
    syncError = msg;
  }

  const skip = (page - 1) * PAGE_SIZE;
  const [orders, total, costCenter, settingsRow] = await Promise.all([
    db.order.findMany({
      where: { shop, isCancelled: false },
      orderBy: { shopifyCreatedAt: "desc" },
      take: PAGE_SIZE,
      skip,
    }),
    db.order.count({ where: { shop, isCancelled: false } }),
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

  const destCityNames = [...new Set(orders.map((o) => o.city).filter(Boolean))];
  const cityCodes = destCityNames.length
    ? await db.tcsCity.findMany({
        where: { shop, cityName: { in: destCityNames } },
        select: { cityName: true, cityCode: true },
      })
    : [];
  const cityCodeMap = Object.fromEntries(
    cityCodes.map((c) => [c.cityName.toLowerCase(), c.cityCode]),
  );

  return {
    orders,
    total,
    page,
    hasMore: skip + orders.length < total,
    syncError,
    costCenter: costCenter ?? null,
    shipperCityCode,
    cityCodeMap,
    storeLogo: settingsRow?.storeLogo ?? null,
  };
};

// ─── Action: book an order ────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  // ── Bulk booking ─────────────────────────────────────────────────────────
  if (formData.get("_action") === "bulk") {
    const orderIds = formData.getAll("orderIds");
    if (!orderIds.length) return { success: false, error: "No orders selected." };

    const orders = await db.order.findMany({
      where: { id: { in: orderIds }, shop, isBooked: false },
      select: {
        id: true, shopifyNumericId: true, name: true,
        customerFirstName: true, customerLastName: true,
        customerPhone: true, city: true, shippingAddress1: true,
        financialStatus: true, totalAmount: true,
      },
    });

    // Stage 1: book all CNs with TCS (batches of 5)
    const tcsResults = await bookTcsShipmentBulk(shop, orders);

    const booked = tcsResults.filter((r) => r.status === "fulfilled").length;
    const failed = tcsResults
      .map((r, i) =>
        r.status === "rejected"
          ? { name: orders[i].name, reason: r.reason.message }
          : null,
      )
      .filter(Boolean);

    // Stage 2: Shopify fulfillment write-back for successfully booked orders (batches of 3)
    const bookedPairs = tcsResults
      .map((r, i) =>
        r.status === "fulfilled"
          ? { order: orders[i], consignmentNo: r.value.consignmentNo }
          : null,
      )
      .filter(Boolean);

    await runInBatches(bookedPairs, 3, async ({ order, consignmentNo }) => {
      const fb = await fulfillShopifyOrder(admin, order, consignmentNo);
      if (fb.fulfillmentId) {
        await db.order
          .update({ where: { id: order.id }, data: { shopifyFulfillmentId: fb.fulfillmentId } })
          .catch((err) => console.error("[Bulk] fulfillmentId save failed:", err.message));
      } else if (fb.skipped) {
        console.log(`[Bulk] Shopify fulfillment skipped for ${order.name} (already fulfilled)`);
      } else if (fb.error) {
        console.warn(`[Bulk] Shopify fulfillment failed for ${order.name}:`, fb.error);
      }
    });

    return { success: true, bulk: true, booked, failed, intent: "bulk" };
  }

  // ── Reset booked order (cancelled externally at TCS portal) ─────────────
  if (formData.get("_action") === "reset") {
    const orderId = formData.get("orderId");
    await db.order.update({
      where: { id: orderId, shop },
      data: { isBooked: false, shipmentStatus: "CANCELLED" },
    });
    return { success: true, intent: "reset" };
  }

  // ── Single booking ───────────────────────────────────────────────────────
  const orderId = formData.get("orderId");
  if (!orderId) return { success: false, error: "Order ID is required.", intent: "book" };

  const order = await db.order.findFirst({
    where: { id: orderId, shop },
    select: {
      id: true, shopifyNumericId: true, name: true,
      customerFirstName: true, customerLastName: true,
      customerPhone: true, city: true, shippingAddress1: true,
      financialStatus: true, totalAmount: true, isBooked: true,
      productSummary: true,
    },
  });

  if (!order) return { success: false, error: "Order not found.", intent: "book" };
  if (order.isBooked) return { success: false, error: "Order already booked.", intent: "book" };

  try {
    const { consignmentNo, remarks } = await bookTcsShipment(shop, order, {
      bookingWeight: formData.get("weight"),
      bookingInstructions: formData.get("instructions"),
      bookingFreeCod: formData.get("freeCod"),
    });

    // Shopify fulfillment write-back (non-blocking — booking still succeeds if this fails)
    let shopifyFulfillmentId = null;
    let fulfillmentError = null;
    try {
      const fb = await fulfillShopifyOrder(admin, order, consignmentNo);
      shopifyFulfillmentId = fb.fulfillmentId;
      if (fb.skipped) {
        // Order already fulfilled in Shopify — nothing to do, not an error
        console.log("[Shopify] Fulfillment write-back skipped (order already fulfilled):", order.name);
      } else if (fb.error) {
        fulfillmentError = fb.error;
        console.warn("[Shopify] Fulfillment write-back failed:", fb.error);
      }
    } catch (fbErr) {
      fulfillmentError = fbErr.message;
      console.error("[Shopify] Fulfillment write-back threw:", fbErr.message);
    }

    if (shopifyFulfillmentId) {
      await db.order
        .update({ where: { id: order.id }, data: { shopifyFulfillmentId } })
        .catch((err) => console.error("[DB] fulfillmentId save failed:", err.message));
    }

    const weightKg = Math.max(parseFloat(formData.get("weight")) || 0.5, 0.5);
    const isPaid   = order.financialStatus?.toLowerCase() === "paid";
    const cod      = isPaid ? 0 : (parseInt(formData.get("freeCod") || order.totalAmount, 10) || 0);
    return {
      success: true,
      intent: "book",
      consignmentNo,
      fulfillmentError,
      bookedOrder: {
        id:                  order.id,
        name:                order.name,
        shopifyNumericId:    order.shopifyNumericId,
        customerFirstName:   order.customerFirstName,
        customerLastName:    order.customerLastName,
        customerPhone:       order.customerPhone,
        city:                order.city,
        shippingAddress1:    order.shippingAddress1,
        financialStatus:     order.financialStatus,
        tcsConsignmentNo:    consignmentNo,
        bookingWeight:       String(weightKg),
        bookingFreeCod:      String(cod),
        bookingInstructions: remarks || null,
        productSummary:      order.productSummary || null,
      },
    };
  } catch (err) {
    console.error("Single booking failed:", err.message);
    return { success: false, error: err.message, intent: "book" };
  }
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Orders() {
  const { orders, total, page, hasMore, syncError, costCenter, shipperCityCode, cityCodeMap, storeLogo } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [weight, setWeight] = useState("");
  const [instructions, setInstructions] = useState("");
  const [freeCod, setFreeCod] = useState("");

  // Booking result banners
  const [bookingResult, setBookingResult] = useState(null); // full bookedOrder object
  const [bulkResult, setBulkResult] = useState(null);       // { booked, failed[] }

  const isBooking = fetcher.state !== "idle";

  const filtered = orders.filter((o) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const name = [o.customerFirstName, o.customerLastName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      o.name?.toLowerCase().includes(q) ||
      name.includes(q) ||
      (o.customerPhone ?? "").toLowerCase().includes(q)
    );
  });

  const [selectedResources, setSelectedResources] = useState([]);

  const unbookedIds = useMemo(
    () => filtered.filter((o) => !o.isBooked).map((o) => o.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered.map((o) => o.id + o.isBooked).join(",")],
  );

  const allResourcesSelected =
    unbookedIds.length > 0 && selectedResources.length === unbookedIds.length;

  const handleSelectionChange = useCallback(
    (selectionType, isSelected, selection) => {
      if (selectionType === "all" || selectionType === "page") {
        setSelectedResources(isSelected ? [...unbookedIds] : []);
      } else if (selectionType === "single") {
        setSelectedResources((prev) =>
          isSelected
            ? [...prev, selection]
            : prev.filter((id) => id !== selection),
        );
      } else if (selectionType === "multi") {
        const [startIndex, endIndex] = selection;
        const rangeIds = filtered
          .slice(startIndex, endIndex + 1)
          .filter((o) => !o.isBooked)
          .map((o) => o.id);
        setSelectedResources((prev) =>
          isSelected
            ? [...new Set([...prev, ...rangeIds])]
            : prev.filter((id) => !rangeIds.includes(id)),
        );
      }
    },
    [unbookedIds, filtered],
  );

  const promotedBulkActions = [
    {
      content: `Book selected (${selectedResources.length})`,
      onAction: () => {
        const formData = new FormData();
        formData.append("_action", "bulk");
        for (const id of selectedResources) formData.append("orderIds", id);
        fetcher.submit(formData, { method: "POST" });
      },
      loading: isBooking,
      disabled: isBooking,
    },
  ];

  const openModal = useCallback((order) => {
    setSelectedOrder(order);
    setWeight("");
    setInstructions("");
    setFreeCod("");
    setModalOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelectedOrder(null);
  }, []);

  const openLabelForOrder = useCallback(
    async (order) => {
      if (!costCenter) {
        shopify.toast.show("No cost center configured.", { isError: true });
        return;
      }
      try {
        const { openTcsLabel } = await import("../components/label/openTcsLabel.client.js");
        await openTcsLabel([order], costCenter, { shipperCityCode, cityCodeMap, storeLogo });
      } catch (err) {
        shopify.toast.show(err.message || "Label failed.", { isError: true });
      }
    },
    [costCenter, shipperCityCode, cityCodeMap, storeLogo, shopify],
  );

  const handleQuickBook = useCallback(
    (order) => {
      fetcher.submit({ orderId: order.id }, { method: "POST" });
    },
    [fetcher],
  );

  const handleConfirmBook = useCallback(() => {
    if (!selectedOrder) return;
    fetcher.submit(
      { orderId: selectedOrder.id, weight, instructions, freeCod },
      { method: "POST" },
    );
  }, [selectedOrder, weight, instructions, freeCod, fetcher]);

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;

    if (data.success) {
      revalidator.revalidate();

      if (data.intent === "bulk") {
        setSelectedResources([]);
        setBulkResult({ booked: data.booked, failed: data.failed ?? [] });
      } else if (data.intent === "reset") {
        shopify.toast.show("Order reset — ready to re-book.");
      } else {
        // Single booking
        closeModal();
        setBookingResult(data.bookedOrder ?? null);
        if (data.fulfillmentError) {
          shopify.toast.show(
            `CN ${data.consignmentNo} booked — Shopify fulfillment failed: ${data.fulfillmentError}`,
            { isError: true },
          );
        }
      }
    }

    if (!data.success && data.error) {
      shopify.toast.show(data.error, { isError: true });
    }
  }, [fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowMarkup = filtered.map((order, index) => {
    const isPaid = order.financialStatus === "paid";
    const amount = order.totalAmount ?? "0";
    const currency = order.currencyCode ?? "";
    const fullName =
      [order.customerFirstName, order.customerLastName]
        .filter(Boolean)
        .join(" ") || "—";

    return (
      <IndexTable.Row
        id={order.id}
        key={order.id}
        position={index}
        selected={selectedResources.includes(order.id)}
        disabled={order.isBooked}
      >
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="semibold" as="span">
            {order.name}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{fullName}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{order.customerPhone ?? "—"}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span">{order.city ?? "—"}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={isPaid ? "success" : "warning"}>
            {isPaid ? "0" : `${amount} ${currency}`}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={isPaid ? "success" : "attention"}>
            {isPaid ? "Paid" : "Pending"}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={order.isBooked ? "info" : undefined}>
            {order.isBooked ? "Booked" : "Not Booked"}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <ButtonGroup>
            <Button
              variant="primary"
              size="slim"
              disabled={order.isBooked}
              loading={
                isBooking && fetcher.formData?.get("orderId") === order.id
              }
              onClick={() => !order.isBooked && handleQuickBook(order)}
            >
              Book
            </Button>
            <Button
              size="slim"
              disabled={order.isBooked}
              onClick={() => !order.isBooked && openModal(order)}
            >
              More
            </Button>
          </ButtonGroup>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Orders" subtitle={`${total} total`}>
      <BlockStack gap="400">
        {syncError && (
          <Banner tone="critical" title="Sync error">
            <p>{syncError}</p>
          </Banner>
        )}

        {/* Single booking result */}
        {bookingResult && (
          <Banner
            tone="success"
            title={`Booked — CN: ${bookingResult.tcsConsignmentNo}`}
            onDismiss={() => setBookingResult(null)}
          >
            <Button
              variant="plain"
              onClick={() => openLabelForOrder(bookingResult)}
            >
              Open Label (PDF)
            </Button>
          </Banner>
        )}

        {/* Bulk booking result */}
        {bulkResult && (
          <Banner
            tone={bulkResult.failed.length ? "warning" : "success"}
            title={`Bulk booking: ${bulkResult.booked} booked${bulkResult.failed.length ? `, ${bulkResult.failed.length} failed` : ""}`}
            onDismiss={() => setBulkResult(null)}
          >
            {bulkResult.failed.length > 0 && (
              <List>
                {bulkResult.failed.map((f) => (
                  <List.Item key={f.name}>
                    {f.name} — {f.reason}
                  </List.Item>
                ))}
              </List>
            )}
          </Banner>
        )}

        {/* Search */}
        <Card>
          <BlockStack gap="300">
            <TextField
              label="Search orders"
              labelHidden
              placeholder="Search by order #, customer name, or phone"
              value={search}
              onChange={setSearch}
              clearButton
              onClearButtonClick={() => setSearch("")}
              autoComplete="off"
            />
            {search.trim() && (
              <Text tone="subdued" as="p">
                {filtered.length} of {total} orders match &ldquo;{search}&rdquo;
              </Text>
            )}
          </BlockStack>
        </Card>

        {/* Table */}
        {filtered.length === 0 ? (
          <Card>
            <Box paddingBlock="1600">
              <Text alignment="center" tone="subdued" as="p">
                {search.trim()
                  ? `No orders match "${search}".`
                  : "No orders found."}
              </Text>
            </Box>
          </Card>
        ) : (
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={filtered.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              promotedBulkActions={
                selectedResources.length > 0 ? promotedBulkActions : undefined
              }
              headings={[
                { title: "Order #" },
                { title: "Customer" },
                { title: "Phone" },
                { title: "City" },
                { title: "COD" },
                { title: "Payment" },
                { title: "Booking" },
                { title: "Actions" },
              ]}
            >
              {rowMarkup}
            </IndexTable>

            {(page > 1 || hasMore) && (
              <Box
                padding="400"
                borderBlockStartWidth="025"
                borderColor="border"
              >
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={page > 1}
                    onPrevious={() => navigate(`/app?page=${page - 1}`)}
                    hasNext={hasMore}
                    onNext={() => navigate(`/app?page=${page + 1}`)}
                    label={`Page ${page} of ${Math.ceil(total / PAGE_SIZE)}`}
                  />
                </InlineStack>
              </Box>
            )}
          </Card>
        )}
      </BlockStack>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={`Book Order — ${selectedOrder?.name ?? ""}`}
        primaryAction={{
          content: "Confirm Book",
          onAction: handleConfirmBook,
          loading: isBooking,
        }}
        secondaryActions={[{ content: "Cancel", onAction: closeModal }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField
              label="Weight (kg)"
              type="number"
              value={weight}
              onChange={setWeight}
              autoComplete="off"
            />
            <TextField
              label="Special Instructions"
              value={instructions}
              onChange={setInstructions}
              multiline={3}
              autoComplete="off"
            />
            <TextField
              label="COD Amount"
              type="number"
              value={freeCod}
              onChange={setFreeCod}
              autoComplete="off"
            />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

// ─── Shopify required exports ─────────────────────────────────────────────────

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);




