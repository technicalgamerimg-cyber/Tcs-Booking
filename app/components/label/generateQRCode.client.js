import QRCode from 'qrcode';

export async function generateQRCode(text) {
  try {
    return await QRCode.toDataURL(String(text || ' '), { errorCorrectionLevel: 'M', margin: 1 });
  } catch (err) {
    console.error('generateQRCode failed:', err);
    return null;
  }
}
