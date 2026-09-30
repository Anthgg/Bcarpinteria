import { Injectable, NotFoundException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { CoreService } from './core/core.service';

@Injectable()
export class DocumentsService {
  constructor(private readonly core: CoreService) {}

  async orderPdf(id: string): Promise<Buffer> {
    const order = await this.core.getOrder(id);
    if (!order) throw new NotFoundException('Pedido no encontrado.');
    const settings = await this.core.getSettings();
    const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:8080';
    const trackingUrl = new URL(`/seguimiento/${order.trackingToken}`, baseUrl).toString();
    const qr = await QRCode.toBuffer(trackingUrl, { type: 'png', width: 320, margin: 1, errorCorrectionLevel: 'M' });
    const logoPath = join(__dirname, '..', 'assets', 'brand', 'carpinteria-360-logo.png');
    const document = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, compress: true });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    const pageWidth = document.page.width;
    const pageHeight = document.page.height;
    const margin = 40;
    const contentWidth = pageWidth - margin * 2;
    const footerLimit = pageHeight - 58;
    const forest = '#1E3B2F';
    const forestSecondary = '#2B4E3F';
    const gold = '#D9A441';
    const ink = '#1B241F';
    const muted = '#5B665F';
    const line = '#E4DED1';
    const format = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
    const date = new Date(order.createdAt).toLocaleDateString('es-PE');
    const orderStatus: Record<string, string> = {
      DRAFT: 'Borrador', CONFIRMED: 'Confirmado', IN_PRODUCTION: 'En producción', READY: 'Listo', DELIVERED: 'Entregado', CANCELLED: 'Cancelado',
    };
    const paymentStatus: Record<string, string> = { PENDING: 'Pendiente', PARTIAL: 'Parcial', PAID: 'Pagado' };
    let cursorY = 0;

    const drawHeader = (continued = false) => {
      document.rect(0, 0, pageWidth, 112).fill(forest);
      document.rect(0, 110, pageWidth, 3).fill(gold);
      if (existsSync(logoPath)) document.image(logoPath, margin, 14, { fit: [78, 82], align: 'center', valign: 'center' });
      document.font('Helvetica-Bold').fontSize(15).fillColor('#FFFDF8').text(settings.companyName || 'Carpintería Ordenada 360°', margin + 92, 31, { width: 228, lineBreak: true });
      document.font('Helvetica').fontSize(8).fillColor('#D7E0D6').text('Fabricación · taller · seguimiento', margin + 92, 71, { width: 230 });
      document.font('Helvetica-Bold').fontSize(8).fillColor('#E0B960').text(continued ? 'FICHA COMERCIAL · CONTINÚA' : 'FICHA COMERCIAL', pageWidth - margin - 184, 29, { width: 184, align: 'right' });
      document.font('Helvetica-Bold').fontSize(15).fillColor('#FFFDF8').text(order.code, pageWidth - margin - 184, 47, { width: 184, align: 'right' });
      document.font('Helvetica').fontSize(8).fillColor('#D7E0D6').text(date, pageWidth - margin - 184, 72, { width: 184, align: 'right' });
      cursorY = 126;
    };

    const drawChip = (x: number, y: number, label: string, value: string, fill: string, color: string, width: number) => {
      document.roundedRect(x, y, width, 39, 6).fill(fill);
      document.font('Helvetica-Bold').fontSize(7).fillColor(muted).text(label.toUpperCase(), x + 10, y + 7, { width: width - 20 });
      document.font('Helvetica-Bold').fontSize(9).fillColor(color).text(value, x + 10, y + 20, { width: width - 20 });
    };

    const drawCustomer = () => {
      const customer = order.customer;
      const statusWidth = (contentWidth - 10) / 2;
      drawChip(margin, cursorY, 'Pedido', orderStatus[order.status] ?? order.status.replaceAll('_', ' '), '#F4EAD3', '#6B4E12', statusWidth);
      drawChip(margin + statusWidth + 10, cursorY, 'Pago', paymentStatus[order.paymentStatus] ?? order.paymentStatus.replaceAll('_', ' '), '#E3EDE5', '#24553A', statusWidth);
      cursorY += 53;
      document.font('Helvetica-Bold').fontSize(7).fillColor(muted).text('CLIENTE', margin, cursorY, { width: contentWidth, characterSpacing: 1.1 });
      const nameY = cursorY + 13;
      document.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(customer.name, margin, nameY, { width: contentWidth, lineGap: 1 });
      const nameHeight = document.heightOfString(customer.name, { width: contentWidth, lineGap: 1 });
      const detailY = nameY + nameHeight + 5;
      const documentText = customer.documentNumber ? `${customer.documentType} ${customer.documentNumber}` : 'No registrado';
      document.font('Helvetica').fontSize(8).fillColor(muted).text(`Documento  ${documentText}`, margin, detailY, { width: 240 });
      document.text(`Teléfono  ${customer.phone || 'No registrado'}`, margin + 260, detailY, { width: contentWidth - 260 });
      let detailHeight = Math.max(
        document.heightOfString(`Documento  ${documentText}`, { width: 240 }),
        document.heightOfString(`Teléfono  ${customer.phone || 'No registrado'}`, { width: contentWidth - 260 }),
      );
      if (customer.address) {
        const addressY = detailY + detailHeight + 4;
        const addressText = `Dirección  ${customer.address}`;
        document.text(addressText, margin, addressY, { width: contentWidth, lineGap: 1 });
        detailHeight += document.heightOfString(addressText, { width: contentWidth, lineGap: 1 }) + 4;
      }
      cursorY = detailY + detailHeight + 14;
    };

    const columns = [
      { label: 'PRODUCTO', width: 108, align: 'left' as const },
      { label: 'DETALLE / MEDIDAS', width: 150, align: 'left' as const },
      { label: 'CANT.', width: 42, align: 'right' as const },
      { label: 'P. UNITARIO', width: 70, align: 'right' as const },
      { label: 'DESCUENTO', width: 68, align: 'right' as const },
      { label: 'IMPORTE', width: 77, align: 'right' as const },
    ];
    const columnX = columns.reduce<number[]>((positions, column, index) => {
      positions.push(index === 0 ? margin : positions[index - 1] + columns[index - 1].width);
      return positions;
    }, []);
    const drawTableHeader = () => {
      document.roundedRect(margin, cursorY, contentWidth, 27, 5).fill('#F2EEE4');
      columns.forEach((column, index) => {
        document.font('Helvetica-Bold').fontSize(7).fillColor(forestSecondary).text(column.label, columnX[index] + (index < 2 ? 8 : 2), cursorY + 9, { width: column.width - (index < 2 ? 10 : 4), align: column.align, lineBreak: false });
      });
      cursorY += 32;
    };
    const newPage = (repeatTableHeader: boolean) => {
      document.addPage();
      drawHeader(true);
      if (repeatTableHeader) drawTableHeader();
    };

    drawHeader();
    drawCustomer();
    drawTableHeader();
    for (let index = 0; index < order.lines.length; index += 1) {
      const lineItem = order.lines[index];
      const dims = [lineItem.lengthMm, lineItem.widthMm, lineItem.heightMm].filter((value) => value !== null && value !== undefined);
      const detail = [lineItem.description, dims.length ? `${dims.join(' × ')} mm` : null].filter(Boolean).join(' · ');
      document.font('Helvetica-Bold').fontSize(9);
      const productHeight = document.heightOfString(lineItem.name, { width: columns[0].width - 12, lineGap: 1 });
      document.font('Helvetica').fontSize(7.5);
      const detailHeight = detail ? document.heightOfString(detail, { width: columns[1].width - 12, lineGap: 1 }) : 0;
      const rowHeight = Math.max(32, productHeight + 14, detailHeight + 14);
      if (cursorY + rowHeight > footerLimit) newPage(true);
      if (index % 2 === 1) document.rect(margin, cursorY, contentWidth, rowHeight).fill('#FBFAF6');
      document.font('Helvetica-Bold').fontSize(9).fillColor(ink).text(lineItem.name, columnX[0] + 6, cursorY + 7, { width: columns[0].width - 12, lineGap: 1 });
      document.font('Helvetica').fontSize(7.5).fillColor(muted).text(detail || '—', columnX[1] + 6, cursorY + 7, { width: columns[1].width - 12, lineGap: 1 });
      document.font('Helvetica').fontSize(8).fillColor(ink).text(String(lineItem.quantity), columnX[2] + 2, cursorY + 9, { width: columns[2].width - 4, align: 'right', lineBreak: false });
      document.text(format(lineItem.unitPriceCents), columnX[3] + 2, cursorY + 9, { width: columns[3].width - 4, align: 'right', lineBreak: false });
      document.text(format(lineItem.discountCents), columnX[4] + 2, cursorY + 9, { width: columns[4].width - 4, align: 'right', lineBreak: false });
      document.font('Helvetica-Bold').text(format(lineItem.lineSubtotalCents), columnX[5] + 2, cursorY + 9, { width: columns[5].width - 4, align: 'right', lineBreak: false });
      document.moveTo(margin, cursorY + rowHeight).lineTo(pageWidth - margin, cursorY + rowHeight).lineWidth(.5).strokeColor(line).stroke();
      cursorY += rowHeight;
    }

    const totalsHeight = 168;
    if (cursorY + totalsHeight > footerLimit) newPage(false);
    cursorY += 18;
    const panelWidth = 276;
    const panelHeight = 159;
    const panelX = pageWidth - margin - panelWidth;
    const panelY = cursorY;
    document.roundedRect(panelX, panelY, panelWidth, panelHeight, 8).fill('#F6F3EC');
    const totalRows = [
      ['Subtotal', format(order.subtotalCents)],
      ['Descuento', `− ${format(order.discountCents)}`],
      ['Base imponible', format(order.subtotalCents - order.discountCents)],
      [`IGV (${(order.taxRateBasisPoints / 100).toFixed(2)}%)`, format(order.taxCents)],
    ];
    totalRows.forEach(([label, value], rowIndex) => {
      const y = panelY + 13 + rowIndex * 18;
      document.font('Helvetica').fontSize(8).fillColor(muted).text(label, panelX + 13, y, { width: 155 });
      document.font('Helvetica-Bold').fontSize(8).fillColor(ink).text(value, panelX + 166, y, { width: 97, align: 'right', lineBreak: false });
    });
    document.roundedRect(panelX + 9, panelY + 87, panelWidth - 18, 31, 5).fill(forest);
    document.font('Helvetica-Bold').fontSize(9).fillColor('#FFFDF8').text('TOTAL', panelX + 18, panelY + 97, { width: 90 });
    document.font('Helvetica-Bold').fontSize(14).fillColor('#FFFDF8').text(format(order.totalCents), panelX + 111, panelY + 94, { width: 145, align: 'right', lineBreak: false });
    document.font('Helvetica').fontSize(8).fillColor(muted).text('Pagado', panelX + 13, panelY + 128, { width: 75 });
    document.font('Helvetica-Bold').fontSize(8).fillColor(ink).text(format(order.paidCents), panelX + 86, panelY + 128, { width: 70, align: 'right', lineBreak: false });
    document.font('Helvetica').fontSize(8).fillColor(muted).text('Saldo pendiente', panelX + 163, panelY + 128, { width: 82 });
    document.font('Helvetica-Bold').fontSize(8).fillColor(ink).text(format(order.totalCents - order.paidCents), panelX + 171, panelY + 141, { width: 90, align: 'right', lineBreak: false });
    cursorY = panelY + panelHeight + 17;

    const trackingHeight = 123;
    if (cursorY + trackingHeight > footerLimit) newPage(false);
    document.roundedRect(margin, cursorY, contentWidth, trackingHeight, 9).fill('#F6F3EC').strokeColor(line).stroke();
    document.image(qr, margin + 12, cursorY + 12, { fit: [98, 98] });
    const trackingTextX = margin + 126;
    document.font('Helvetica-Bold').fontSize(11).fillColor(forest).text('SIGUE TU PEDIDO', trackingTextX, cursorY + 18, { width: contentWidth - 142 });
    document.font('Helvetica').fontSize(9).fillColor(ink).text('Escanea el código para ver el avance de tu pedido.', trackingTextX, cursorY + 38, { width: contentWidth - 142 });
    document.font('Helvetica').fontSize(7.5).fillColor(muted).text(trackingUrl, trackingTextX, cursorY + 62, { width: contentWidth - 142, height: 44, link: trackingUrl, lineGap: 1 });
    cursorY += trackingHeight;

    const pageRange = document.bufferedPageRange();
    for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
      document.switchToPage(pageIndex);
      document.moveTo(margin, pageHeight - 44).lineTo(pageWidth - margin, pageHeight - 44).lineWidth(.6).strokeColor(line).stroke();
      document.font('Helvetica-Bold').fontSize(7).fillColor(forest).text(settings.companyName || 'Carpintería Ordenada 360°', margin, pageHeight - 34, { width: 205, lineBreak: false });
      document.font('Helvetica').fontSize(7).fillColor(muted).text('Ficha de seguimiento comercial · Este documento no constituye comprobante de pago.', margin + 205, pageHeight - 34, { width: 260, align: 'center', lineBreak: false });
      document.font('Helvetica').fontSize(7).fillColor(muted).text(`Página ${pageIndex - pageRange.start + 1} de ${pageRange.count}`, pageWidth - margin - 66, pageHeight - 34, { width: 66, align: 'right', lineBreak: false });
    }
    document.end();
    return finished;
  }
}
