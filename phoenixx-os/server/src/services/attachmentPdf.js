import PDFDocument from 'pdfkit';

/**
 * Turns an uploaded attachment into a PDF for the "Download as PDF" button.
 * A PDF is returned as it is; a PNG or JPEG becomes one A4 page with the
 * picture fitted to it; plain text and CSV are set as text. Anything else
 * (Word, Excel, zip...) cannot be converted here and resolves to null, so the
 * caller can offer the original file instead.
 */
const IMAGE = /^image\/(png|jpe?g)$/i;
const TEXT = /^text\/(plain|csv)$/i;

export const pdfConvertible = (mime = '', filename = '') => {
  const ext = String(filename).split('.').pop().toLowerCase();
  return mime === 'application/pdf' || ext === 'pdf'
    || IMAGE.test(mime) || ['png', 'jpg', 'jpeg'].includes(ext)
    || TEXT.test(mime) || ['txt', 'csv'].includes(ext);
};

export async function attachmentToPdf({ data, mime = '', filename = '' }) {
  const ext = String(filename).split('.').pop().toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return data;

  const isImage = IMAGE.test(mime) || ['png', 'jpg', 'jpeg'].includes(ext);
  const isText = TEXT.test(mime) || ['txt', 'csv'].includes(ext);
  if (!isImage && !isText) return null;

  const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: filename, Creator: 'Phoenixx OS' } });
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  if (isImage) {
    const w = doc.page.width - 72;
    const h = doc.page.height - 72;
    doc.image(data, 36, 36, { fit: [w, h], align: 'center', valign: 'center' });
  } else {
    doc.font('Helvetica-Bold').fontSize(13).text(filename);
    doc.moveDown(0.6);
    doc.font('Courier').fontSize(9.5).text(data.toString('utf8'), { lineGap: 1.5 });
  }
  doc.end();
  return done;
}
