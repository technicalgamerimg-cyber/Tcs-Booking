import { useState, useCallback, useEffect, useMemo } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
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
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizePaymentStatus } from "../utils/orderStatus";

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
          shippingAddress { city }
          displayFinancialStatus
          displayFulfillmentStatus
          createdAt
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

    for (const { node } of edges) {
      const numericId = node.id.replace("gid://shopify/Order/", "");
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
          financialStatus: normalizePaymentStatus(node.displayFinancialStatus),
          fulfillmentStatus: node.displayFulfillmentStatus ?? null,
          shopifyCreatedAt: node.createdAt ? new Date(node.createdAt) : null,
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
          financialStatus: normalizePaymentStatus(node.displayFinancialStatus),
          fulfillmentStatus: node.displayFulfillmentStatus ?? null,
          ...(node.displayFulfillmentStatus?.toUpperCase() === "FULFILLED"
            ? { isBooked: true }
            : {}),
        },
      });
    }
  } catch (err) {
    const msg =
      err?.graphQLErrors?.map((e) => e.message).join(", ") ??
      err?.message ??
      "Unknown error";
    console.error("Orders sync failed:", msg);
    syncError = msg;
  }

  const skip = (page - 1) * PAGE_SIZE;
  const [orders, total] = await Promise.all([
    db.order.findMany({
      where: { shop, isCancelled: false },
      orderBy: { shopifyCreatedAt: "desc" },
      take: PAGE_SIZE,
      skip,
    }),
    db.order.count({ where: { shop, isCancelled: false } }),
  ]);

  return { orders, total, page, hasMore: skip + orders.length < total, syncError };
};

// ─── Action: book an order ────────────────────────────────────────────────────

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("_action") === "bulk") {
    const orderIds = formData.getAll("orderIds");
    if (!orderIds.length) return { success: false, error: "No orders selected." };

    try {
      const result = await db.order.updateMany({
        where: { id: { in: orderIds }, isBooked: false },
        data: { isBooked: true },
      });
      return { success: true, bulk: true, count: result.count };
    } catch (err) {
      console.error("Bulk booking failed:", err.message);
      return { success: false, error: `Bulk booking failed: ${err.message}` };
    }
  }

  const orderId = formData.get("orderId");
  if (!orderId) return { success: false, error: "Order ID is required." };

  try {
    await db.order.update({
      where: { id: orderId },
      data: {
        isBooked: true,
        bookingWeight: formData.get("weight") || null,
        bookingInstructions: formData.get("instructions") || null,
        bookingFreeCod: formData.get("freeCod") || null,
      },
    });
    return { success: true, orderId };
  } catch (err) {
    console.error("Booking failed:", err.message);
    return { success: false, error: `Booking failed: ${err.message}` };
  }
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Orders() {
  const { orders, total, page, hasMore, syncError } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [weight, setWeight] = useState("");
  const [instructions, setInstructions] = useState("");
  const [freeCod, setFreeCod] = useState("");

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
    if (!fetcher.data) return;
    if (fetcher.data.success) {
      if (fetcher.data.bulk) {
        setSelectedResources([]);
        shopify.toast.show(
          `${fetcher.data.count} order${fetcher.data.count !== 1 ? "s" : ""} booked successfully`,
        );
      } else {
        closeModal();
        shopify.toast.show("Order booked successfully");
      }
    }
    if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, closeModal, shopify]);

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
                    onPrevious={() => {
                      window.location.href = `/app?page=${page - 1}`;
                    }}
                    hasNext={hasMore}
                    onNext={() => {
                      window.location.href = `/app?page=${page + 1}`;
                    }}
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
