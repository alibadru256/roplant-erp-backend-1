const PDFDocument = require('pdfkit');

/**
 * Streams a real PDF document directly to the HTTP response. This is a genuine PDF file —
 * openable, savable, emailable — generated server-side, as distinct from the frontend's
 * "browser print dialog -> Save as PDF" flow (which still works and is fine for a quick
 * print, but isn't a file you can attach to an email without that manual step).
 */
function streamDocumentPdf(res, { filename, companyInfo, docTitle, docNo, date, extraInfo = [], billedTo, items, subtotal, discount = 0, tax, total, footer }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  // ---- Header: company block left, document info right ----
  doc.fontSize(18).fillColor('#1E3A8A').text(companyInfo.company_name.toUpperCase(), 50, 50);
  doc.fontSize(9).fillColor('#333')
    .text(companyInfo.address || '', 50, 72)
    .text(`Tel: ${companyInfo.phone || ''}`, 50, 85)
    .text(companyInfo.email || '', 50, 98);

  doc.fontSize(16).fillColor('#1E3A8A').text(docTitle, 300, 50, { align: 'right' });
  doc.fontSize(9).fillColor('#333');
  let infoY = 72;
  for (const [label, value] of [['Date', date], ['Document No', docNo], ...extraInfo]) {
    doc.text(`${label}: ${value}`, 300, infoY, { align: 'right' });
    infoY += 13;
  }

  doc.moveTo(50, 120).lineTo(545, 120).strokeColor('#1a1a1a').stroke();

  // ---- Billed to ----
  doc.fontSize(9).fillColor('#666').text('Billed To:', 50, 132);
  doc.fillColor('#1a1a1a').text(billedTo, 105, 132);

  // ---- Item table ----
  let y = 160;
  doc.fontSize(9).fillColor('#666');
  doc.text('Code', 50, y).text('Description', 110, y).text('Qty', 330, y, { width: 40, align: 'center' })
    .text('Unit Price', 380, y, { width: 70, align: 'right' }).text('Nett Price', 460, y, { width: 85, align: 'right' });
  y += 14;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#1a1a1a').stroke();
  y += 8;

  doc.fillColor('#1a1a1a');
  for (const item of items) {
    if (y > 700) { doc.addPage(); y = 50; } // simple pagination for long carts/quotations
    doc.fontSize(9)
      .text(item.code || '-', 50, y, { width: 55 })
      .text(item.description, 110, y, { width: 210 })
      .text(String(item.qty), 330, y, { width: 40, align: 'center' })
      .text(fmtMoney(item.unitPrice), 380, y, { width: 70, align: 'right' })
      .text(fmtMoney(item.qty * item.unitPrice), 460, y, { width: 85, align: 'right' });
    y += 18;
  }

  y += 10;
  doc.moveTo(350, y).lineTo(545, y).strokeColor('#ccc').stroke();
  y += 8;
  const totalsLine = (label, value, bold = false) => {
    doc.fontSize(9).fillColor(bold ? '#1a1a1a' : '#666').font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, 380, y, { width: 70, align: 'right' })
      .text(fmtMoney(value), 460, y, { width: 85, align: 'right' });
    y += 16;
  };
  totalsLine('Sub Total', subtotal);
  if (discount) totalsLine('Discount', -discount);
  totalsLine('Tax', tax);
  totalsLine('Total', total, true);

  if (footer) {
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(footer, 50, y + 20, { width: 495 });
  }
  doc.text('Signed: ______________________', 50, y + 60);
  doc.text('Date: ______________________', 320, y + 60);

  doc.end();
}

function fmtMoney(n) {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
}

module.exports = { streamDocumentPdf };
