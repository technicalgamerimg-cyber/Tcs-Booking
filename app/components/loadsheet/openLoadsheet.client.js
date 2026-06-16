import { pdf } from '@react-pdf/renderer';
import React from 'react';
import LoadsheetDocument from './LoadsheetDocument.jsx';

export async function openLoadsheetPdf(rows, generatedAt) {
  if (!rows || rows.length === 0) throw new Error('No rows to generate loadsheet.');

  const blob = await pdf(
    React.createElement(LoadsheetDocument, {
      rows,
      generatedAt: generatedAt || new Date().toISOString(),
    }),
  ).toBlob();

  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}
