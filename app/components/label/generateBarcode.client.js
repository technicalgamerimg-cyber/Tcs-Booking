import bwipjs from 'bwip-js';

export function generateBarcode(text, includeText = true) {
  const canvas = document.createElement('canvas');
  bwipjs.toCanvas(canvas, {
    bcid:        'code128',
    text:        String(text || ' '),
    scale:       3,
    height:      10,
    includetext: includeText,
    textxalign:  'center',
  });
  return canvas.toDataURL('image/png');
}
