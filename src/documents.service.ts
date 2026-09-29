import { Injectable, NotFoundException } from '@nestjs/common';
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
    const qr = await QRCode.toBuffer(trackingUrl, { type: 'png', width: 260, margin: 1 });
    const document = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.on('error', reject);
    });

    const format = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
    document.fontSize(21).fillColor('#24342d').text(settings.companyName, { continued: false });
    document.moveDown(0.3).fontSize(10).fillColor('#69756f').text('Ficha comercial del pedido');
    document.moveDown(1).fontSize(16).fillColor('#17211d').text(order.code);
    document.moveDown(0.4).fontSize(10).fillColor('#17211d');
    document.text(`Cliente: ${order.customer.name}`);
    if (order.customer.documentNumber) document.text(`Documento: ${order.customer.documentType} ${order.customer.documentNumber}`);
    if (order.customer.phone) document.text(`Teléfono: ${order.customer.phone}`);
    document.text(`Fecha: ${order.createdAt.toLocaleDateString('es-PE')}`);
    document.text(`Estado de pago: ${order.paymentStatus}`);
    document.moveDown(1);
    const x = 48;
    const y = document.y;
    document.fontSize(9).fillColor('#69756f');
    document.text('PRODUCTO', x, y, { width: 250 });
    document.text('CANT.', 302, y, { width: 48, align: 'right' });
    document.text('P. UNITARIO', 360, y, { width: 78, align: 'right' });
    document.text('TOTAL', 448, y, { width: 95, align: 'right' });
    document.moveDown(0.7).strokeColor('#d9dfdc').moveTo(x, document.y).lineTo(547, document.y).stroke();
    for (const line of order.lines) {
      const lineY = document.y + 8;
      const lineTotal = line.lineSubtotalCents;
      document.fontSize(10).fillColor('#17211d').text(line.name, x, lineY, { width: 240 });
      const dims = [line.lengthMm, line.widthMm, line.heightMm].filter((value) => value !== null);
      if (line.description || dims.length) document.fontSize(8).fillColor('#69756f').text([line.description, dims.length ? `${dims.join(' × ')} mm` : null].filter(Boolean).join(' · '), x, document.y, { width: 240 });
      document.fontSize(10).fillColor('#17211d').text(String(line.quantity), 302, lineY, { width: 48, align: 'right' });
      document.text(format(line.unitPriceCents), 360, lineY, { width: 78, align: 'right' });
      document.text(format(lineTotal), 448, lineY, { width: 95, align: 'right' });
      document.moveDown(1.2).strokeColor('#eef0ee').moveTo(x, document.y).lineTo(547, document.y).stroke();
    }
    document.moveDown(0.8);
    document.fontSize(10).fillColor('#35443d');
    document.text(`Subtotal: ${format(order.subtotalCents)}`, { align: 'right' });
    document.text(`Descuento: − ${format(order.discountCents)}`, { align: 'right' });
    document.text(`IGV (${(order.taxRateBasisPoints / 100).toFixed(2)}%): ${format(order.taxCents)}`, { align: 'right' });
    document.moveDown(0.2).fontSize(15).fillColor('#17211d').text(`Total: ${format(order.totalCents)}`, { align: 'right' });
    document.moveDown(0.5).fontSize(9).fillColor('#69756f').text(`Pagado: ${format(order.paidCents)} · Saldo: ${format(order.totalCents - order.paidCents)}`, { align: 'right' });
    document.moveDown(1.4);
    const qrY = Math.max(document.y, 610);
    document.image(qr, x, qrY, { width: 92, height: 92 });
    document.fontSize(9).fillColor('#35443d').text('Escanea para consultar el avance del pedido', x + 106, qrY + 12, { width: 250 });
    document.fontSize(8).fillColor('#69756f').text(trackingUrl, x + 106, qrY + 31, { width: 300 });
    document.end();
    return finished;
  }
}
