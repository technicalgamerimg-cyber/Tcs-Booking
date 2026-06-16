import { pdf }            from '@react-pdf/renderer';
import React               from 'react';
import LabelDocument       from './LabelDocument.jsx';
import { mapOrderToLabel } from './mapOrderToLabel.client.js';

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function openTcsLabel(orders, costCenter, { shipperCityCode = '', cityCodeMap = {}, storeLogo = null } = {}) {
  const targets = Array.isArray(orders) ? orders : [orders];
  if (!targets.length) throw new Error('No orders to print.');

  const tcsLogo = await fetchImageAsBase64(window.location.origin + '/tcs-logo.png');

  const labelDataArray = await Promise.all(
    targets.map((order) => {
      const destCityCode = cityCodeMap[(order.city || '').toLowerCase()] || '';
      return mapOrderToLabel(order, costCenter, { shipperCityCode, destCityCode, storeLogo, tcsLogo });
    }),
  );

  const blob = await pdf(React.createElement(LabelDocument, { orders: labelDataArray })).toBlob();
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
}
