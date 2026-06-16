import React from 'react';
import { Document, Page, View, Text, StyleSheet, Font } from '@react-pdf/renderer';

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 8,
    padding: 24,
    backgroundColor: '#fff',
  },
  header: {
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    paddingBottom: 8,
  },
  title: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 8,
    color: '#555',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 6,
    marginBottom: 12,
  },
  statBox: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#f3f4f6',
    borderRadius: 2,
  },
  statLabel: { fontSize: 7, color: '#666' },
  statValue: { fontSize: 9, fontFamily: 'Helvetica-Bold' },
  table: { width: '100%' },
  thead: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    paddingVertical: 5,
  },
  tbody: {},
  tr: {
    flexDirection: 'row',
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e7eb',
  },
  trAlt: { backgroundColor: '#f9fafb' },
  th: { fontFamily: 'Helvetica-Bold', color: '#fff', fontSize: 7 },
  td: { fontSize: 7.5, color: '#111' },
  // Column widths — paddingLeft/Right create visible gaps between cells
  colCn:       { width: '19%', paddingLeft: 6, paddingRight: 6 },
  colOrder:    { width: '8%',  paddingRight: 6 },
  colCustomer: { width: '17%', paddingRight: 6 },
  colCity:     { width: '11%', paddingRight: 6 },
  colWeight:   { width: '9%',  paddingRight: 6, textAlign: 'right' },
  colCod:      { width: '12%', paddingRight: 6, textAlign: 'right' },
  colDate:     { width: '13%', paddingRight: 6 },
  colStatus:   { width: '11%', paddingLeft: 4 },
  footer: {
    position: 'absolute',
    bottom: 16,
    left: 24,
    right: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: '#ccc',
    paddingTop: 4,
  },
  footerText: { fontSize: 7, color: '#888' },
});

function formatDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-PK', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export default function LoadsheetDocument({ rows, generatedAt }) {
  const totalCod    = rows.reduce((s, r) => s + (parseFloat(r.bookingFreeCod) || 0), 0);
  const totalWeight = rows.reduce((s, r) => s + (parseFloat(r.bookingWeight) || 0), 0);
  const dateLabel   = generatedAt
    ? new Date(generatedAt).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })
    : new Date().toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Document>
      <Page size="A4" orientation="landscape" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>TCS Shipments Loadsheet</Text>
          <Text style={styles.subtitle}>Generated: {dateLabel} | {rows.length} shipment{rows.length !== 1 ? 's' : ''}</Text>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Shipments</Text>
            <Text style={styles.statValue}>{rows.length}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total COD</Text>
            <Text style={styles.statValue}>Rs {totalCod.toLocaleString()}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Weight</Text>
            <Text style={styles.statValue}>{totalWeight.toFixed(2)} kg</Text>
          </View>
        </View>

        {/* Table */}
        <View style={styles.table}>
          {/* Header row */}
          <View style={styles.thead}>
            <Text style={[styles.th, styles.colCn]}>CN #</Text>
            <Text style={[styles.th, styles.colOrder]}>Order</Text>
            <Text style={[styles.th, styles.colCustomer]}>Customer</Text>
            <Text style={[styles.th, styles.colCity]}>City</Text>
            <Text style={[styles.th, styles.colWeight]}>Weight</Text>
            <Text style={[styles.th, styles.colCod]}>COD (Rs)</Text>
            <Text style={[styles.th, styles.colDate]}>Booked At</Text>
            <Text style={[styles.th, styles.colStatus]}>Status</Text>
          </View>

          {/* Data rows */}
          {rows.map((r, i) => {
            const fullName = [r.customerFirstName, r.customerLastName].filter(Boolean).join(' ') || '—';
            const cod = parseFloat(r.bookingFreeCod) || 0;
            const wt  = parseFloat(r.bookingWeight) || 0;
            return (
              <View key={r.id || i} style={[styles.tr, i % 2 === 1 ? styles.trAlt : {}]}>
                <Text style={[styles.td, styles.colCn]}>{r.tcsConsignmentNo || '—'}</Text>
                <Text style={[styles.td, styles.colOrder]}>{r.name}</Text>
                <Text style={[styles.td, styles.colCustomer]}>{fullName}</Text>
                <Text style={[styles.td, styles.colCity]}>{r.city || '—'}</Text>
                <Text style={[styles.td, styles.colWeight]}>{wt.toFixed(2)}</Text>
                <Text style={[styles.td, styles.colCod]}>{cod > 0 ? cod.toLocaleString() : '—'}</Text>
                <Text style={[styles.td, styles.colDate]}>{formatDate(r.bookedAt)}</Text>
                <Text style={[styles.td, styles.colStatus]}>{r.shipmentStatus || 'BOOKED'}</Text>
              </View>
            );
          })}
        </View>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>TCS Loadsheet — Confidential</Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
