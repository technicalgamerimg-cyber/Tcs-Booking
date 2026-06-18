import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {};
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>TCS Booking</h1>
        <p className={styles.text}>
          Book TCS courier shipments directly from your Shopify orders.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Automatic consignments.</strong> Generate TCS consignment
            numbers from your Shopify orders in one click.
          </li>
          <li>
            <strong>Fulfillment sync.</strong> Orders are automatically marked
            as fulfilled in Shopify with TCS tracking info.
          </li>
          <li>
            <strong>Loadsheet generation.</strong> Print daily loadsheets and
            track shipment status across all your orders.
          </li>
        </ul>
        <p className={styles.text}>
          Install TCS Booking from the Shopify App Store to get started.
        </p>
      </div>
    </div>
  );
}
