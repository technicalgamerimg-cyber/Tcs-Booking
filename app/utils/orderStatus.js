/**
 * Normalizes any Shopify financial_status or displayFinancialStatus value
 * into one of two explicit stored values: "paid" | "pending_payment"
 *
 * Shopify GraphQL returns uppercase (e.g. "PAID")
 * Shopify webhook payload returns lowercase (e.g. "paid")
 * Both are handled here so the DB always stores a clean, consistent value.
 */
export function normalizePaymentStatus(status) {
  if (!status) return "pending_payment";
  return status.toLowerCase() === "paid" ? "paid" : "pending_payment";
}

/**
 * Maps our stored booking boolean to a display label.
 */
export function bookingStatusLabel(isBooked) {
  return isBooked ? "booked" : "not_booked";
}
