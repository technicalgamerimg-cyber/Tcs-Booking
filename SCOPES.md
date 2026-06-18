# Scope Justification — TCS Booking

This document explains why each API scope is requested by the TCS Booking app.

## read_orders
**Used in:** `app/routes/app._index.jsx` — `FetchOrders` GraphQL query  
**Why:** The Orders page fetches the merchant's orders via the Admin GraphQL API to display
them for TCS booking. Without this scope the orders list cannot be loaded.

## write_orders
**Used in:** `app/utils/shopify.server.js` — `fulfillmentCreateV2` mutation (side effect)  
**Why:** When a TCS shipment is booked, the app creates a Shopify fulfillment with tracking
info. Shopify's fulfillment creation transitions the order's fulfillment status, which requires
write access to orders.

## read_fulfillments
**Used in:** `app/utils/shopify.server.js` — `GetFulfillmentOrders` query  
**Why:** Before creating a fulfillment, the app queries the order's fulfillment orders to find
one with OPEN status. This check prevents duplicate fulfillments.

## write_fulfillments
**Used in:** `app/utils/shopify.server.js` — `FulfillmentCreateV2` and `FulfillmentCancel` mutations  
**Why:** After a successful TCS booking, the app creates a Shopify fulfillment with the TCS
consignment number and tracking URL. When a TCS shipment is cancelled, the app cancels the
corresponding Shopify fulfillment to keep order status in sync.

## read_merchant_managed_fulfillment_orders
**Used in:** `app/utils/shopify.server.js` — `fulfillmentOrders` field on Order  
**Why:** The `fulfillmentOrders` connection on an Order object requires this scope to return
fulfillment order nodes. Without it, the query returns an empty list and the app cannot
determine whether the order is ready to be fulfilled.

## write_merchant_managed_fulfillment_orders
**Used in:** `app/utils/shopify.server.js` — `FulfillmentCreateV2` mutation  
**Why:** Required by Shopify when transitioning merchant-managed fulfillment orders through
the fulfillment lifecycle. The `fulfillmentCreateV2` mutation moves line items from the
fulfillment order into a fulfillment, which requires write access to fulfillment orders.
