import { generateBarcode } from './generateBarcode.client.js';
import { generateQRCode }  from './generateQRCode.client.js';

function base64EncodeUnicode(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  const latin1    = String.fromCharCode(...utf8Bytes);
  return btoa(latin1);
}

/**
 * Maps a DB Order row + TcsCostCenter row → the flat label object that
 * TCSShippingLabel expects.
 *
 * @param {object} order        - DB Order with all fields
 * @param {object} costCenter   - TcsCostCenter row (shipper info)
 * @param {object} opts
 * @param {string} opts.shipperCityCode - TCS city code for the shipper city
 * @param {string} opts.destCityCode    - TCS city code for the consignee city
 */
export async function mapOrderToLabel(order, costCenter, { shipperCityCode = '', destCityCode = '', storeLogo = null, tcsLogo = null } = {}) {
  const trackingNo = order.tcsConsignmentNo || '';
  const codStr     = String(order.bookingFreeCod || 0);
  const codAmount  = parseFloat(codStr) || 0;
  const weightG    = Math.round((parseFloat(order.bookingWeight) || 0.5) * 1000);
  const fullName   = [order.customerFirstName, order.customerLastName].filter(Boolean).join(' ') || 'Customer';

  // TCS barcode payloads (mirrors the TCS strategy in mapShippingLabelData.js)
  const codBarcodeText = `RS${codStr}`;

  const qrInner = [
    trackingNo,
    destCityCode,
    codStr,
    'O',
    fullName,
    `${order.shippingAddress1 || order.city || ''}, ${order.city || ''}`,
    order.customerPhone || '',
  ].join('|');

  const qrPayload    = `${trackingNo}-${shipperCityCode}${destCityCode}-${codStr}-${base64EncodeUnicode(qrInner)}`;
  const extraBarcode = `${trackingNo}-${shipperCityCode}${destCityCode}-${codStr}`;

  const [trackingBarcode, codBarcode, qrCode, thirdBarcode] = await Promise.all([
    Promise.resolve(generateBarcode(trackingNo)),
    Promise.resolve(generateBarcode(codBarcodeText, true)),
    generateQRCode(qrPayload),
    Promise.resolve(generateBarcode(extraBarcode, false)),
  ]);

  const weightDisplay = order.bookingWeight
    ? `${parseFloat(order.bookingWeight).toFixed(2)} kg`
    : '0.50 kg';

  return {
    courier_code:     'TCS',
    courier_logo_url: tcsLogo || '',
    store_logo_url:   storeLogo || '',
    tracking_number:  trackingNo,
    order_number:     order.name,
    fulfillment_date: new Date().toISOString(),
    service_type:     'OVERNIGHT',
    cod_amount:       codAmount,
    pieces:           '1/1',
    weight:           weightG,
    fragile:          false,
    product_details:  order.productSummary || `Weight: ${weightDisplay}`,
    shipping_instructions:    order.bookingInstructions || '',
    special_shipper_remarks:  '',

    barcodes: {
      tracking_number:   trackingBarcode,
      cod_amount:        codBarcode,
      tcs_third_barcode: thirdBarcode,
    },
    qr_codes: { details: qrCode },

    destination_address: {
      name:          fullName,
      first_name:    order.customerFirstName || '',
      last_name:     order.customerLastName  || '',
      address1:      order.shippingAddress1  || order.city || '',
      address2:      '',
      city:          order.city || '',
      tcs_city_code: destCityCode,
      zip: '', province: '', country: 'Pakistan',
      phone:   order.customerPhone || '',
      email:   '',
      company: '',
    },

    shipper_details: {
      name:          costCenter.costCenterName || '',
      address1:      costCenter.pickupAddress  || costCenter.costCenterCity || '',
      address2:      '',
      city:          costCenter.costCenterCity || '',
      tcs_city_code: shipperCityCode,
      country: 'Pakistan', province: '', zip: '',
      phone:   costCenter.phone  || '',
      email:   costCenter.email  || '',
      first_name: '', last_name: '', company: '',
    },
  };
}
