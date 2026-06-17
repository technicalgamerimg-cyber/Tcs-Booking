const GET_FULFILLMENT_ORDERS = `#graphql
  query GetFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 20) {
        nodes { id status assignedLocation { location { id } } }
      }
    }
  }
`;

const FULFILLMENT_CREATE = `#graphql
  mutation FulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_CANCEL = `#graphql
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

function gqlErrors(json) {
  return json.errors?.length ? json.errors.map((e) => e.message).join(', ') : null;
}

/**
 * Creates a Shopify fulfillment with TCS tracking info.
 * Never throws — returns { fulfillmentId, error }.
 */
export async function fulfillShopifyOrder(admin, order, consignmentNo) {
  try {
    // Step 1: get open fulfillment order
    const foRes  = await admin.graphql(GET_FULFILLMENT_ORDERS, { variables: { orderId: order.id } });
    const foJson = await foRes.json();

    const topErr = gqlErrors(foJson);
    if (topErr) return { fulfillmentId: null, error: topErr };

    const fulfillmentOrders = foJson.data?.order?.fulfillmentOrders?.nodes ?? [];
    const openFO = fulfillmentOrders.find((fo) => fo.status === 'OPEN');

    if (!openFO) {
      const statuses = fulfillmentOrders.map((fo) => fo.status);
      const allClosed = statuses.length > 0 && statuses.every((s) => s === 'CLOSED');
      if (allClosed) {
        // Order already fulfilled externally — skip silently, not a write-back error
        return { fulfillmentId: null, error: null, skipped: true };
      }
      return { fulfillmentId: null, error: `No open fulfillment order (found: ${statuses.join(', ') || 'none'})` };
    }

    // Step 2: create fulfillment
    const mutRes  = await admin.graphql(FULFILLMENT_CREATE, {
      variables: {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: openFO.id }],
          trackingInfo: {
            company: 'TCS Courier',
            number: consignmentNo,
            url: `https://www.tcsexpress.com/track/${consignmentNo}`,
          },
          notifyCustomer: false,
        },
      },
    });
    const mutJson = await mutRes.json();

    const mutTopErr = gqlErrors(mutJson);
    if (mutTopErr) return { fulfillmentId: null, error: mutTopErr };

    const userErrors = mutJson.data?.fulfillmentCreateV2?.userErrors ?? [];
    if (userErrors.length) {
      return { fulfillmentId: null, error: userErrors.map((e) => `${e.field}: ${e.message}`).join(', ') };
    }

    const fulfillmentId = mutJson.data?.fulfillmentCreateV2?.fulfillment?.id ?? null;
    if (!fulfillmentId) return { fulfillmentId: null, error: 'Mutation returned no fulfillment ID' };

    return { fulfillmentId, error: null };
  } catch (err) {
    return { fulfillmentId: null, error: err.message };
  }
}

/**
 * Cancels a Shopify fulfillment.
 * Never throws — returns { success, error }.
 */
export async function cancelShopifyFulfillment(admin, shopifyFulfillmentId) {
  try {
    const res  = await admin.graphql(FULFILLMENT_CANCEL, { variables: { id: shopifyFulfillmentId } });
    const json = await res.json();

    const topErr = gqlErrors(json);
    if (topErr) return { success: false, error: topErr };

    const userErrors = json.data?.fulfillmentCancel?.userErrors ?? [];
    if (userErrors.length) {
      return { success: false, error: userErrors.map((e) => e.message).join(', ') };
    }

    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
