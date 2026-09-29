import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma.service';
import { CoreService } from './core.service';

describe('CoreService inventory workbook import', () => {
  let directory: string;
  let previousPath: string | undefined;
  let service: CoreService;
  const findMany = jest.fn();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carpinteria-inventory-'));
    previousPath = process.env.BD_PATH;
    findMany.mockReset().mockResolvedValue([]);
    service = new CoreService({ inventoryItem: { findMany } } as unknown as PrismaService);
  });

  afterEach(async () => {
    if (previousPath === undefined) delete process.env.BD_PATH;
    else process.env.BD_PATH = previousPath;
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  });

  it('previews the supplied workbook without changing it', async () => {
    const workbookPath = resolve(__dirname, '../../bd/inventario g.xlsx');
    process.env.BD_PATH = workbookPath;

    const report = await service.previewImport();

    expect(report).toMatchObject({ source: 'inventario g.xlsx', sheet: expect.any(String), validRows: 14, invalidRows: 0 });
    expect(report.rows).toHaveLength(14);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('reports duplicate names and blank stock before import', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario');
    sheet.addRow(['ID', 'MATERIAL', 'UNIDAD', 'STOCK', 'PRECIO UNITARIO']);
    sheet.addRow(['A-1', 'Pino seco', 'UND', 2, 15.5]);
    sheet.addRow(['A-2', 'PINO SECO', 'UND', 1, 14]);
    sheet.addRow(['A-3', 'Barniz mate', 'L', '', 18]);
    const workbookPath = join(directory, 'validation.xlsx');
    await workbook.xlsx.writeFile(workbookPath);
    process.env.BD_PATH = workbookPath;

    const report = await service.previewImport();

    expect(report).toMatchObject({ validRows: 1, invalidRows: 2 });
    expect(report.rows[1].error).toMatch(/duplicado/i);
    expect(report.rows[2].error).toMatch(/stock/i);
  });

  it('rejects duplicated required headers in an unexpected workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventario');
    sheet.addRow(['ID', 'MATERIAL', 'UNIDAD', 'STOCK', 'PRECIO UNITARIO', 'ID']);
    sheet.addRow(['A-1', 'Pino seco', 'UND', 2, 15.5, 'A-2']);
    const workbookPath = join(directory, 'duplicate-headers.xlsx');
    await workbook.xlsx.writeFile(workbookPath);
    process.env.BD_PATH = workbookPath;

    await expect(service.previewImport()).rejects.toThrow(/columnas obligatorias duplicadas/i);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('CoreService payments and input validation', () => {
  it('records a partial payment in rounded integer cents', async () => {
    const order = { id: 'order-1', status: 'CONFIRMED', paidCents: 0, totalCents: 10000 };
    const tx = {
      order: { findUnique: jest.fn().mockResolvedValue(order), update: jest.fn().mockResolvedValue({}) },
      payment: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    const service = new CoreService(prisma as unknown as PrismaService);

    const result = await service.addPayment({ id: 'user-1' } as never, order.id, { amount: 1.005, method: 'Efectivo' });

    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 101 }) }));
    expect(result).toEqual({ paidCents: 101, totalCents: 10000, paymentStatus: 'PARTIAL' });
  });

  it('rejects overpayments, payments on cancelled orders, and invalid dates before writing', async () => {
    const order = { id: 'order-1', status: 'CONFIRMED', paidCents: 9000, totalCents: 10000 };
    const tx = {
      order: { findUnique: jest.fn().mockResolvedValue(order), update: jest.fn() },
      payment: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((operation: (client: typeof tx) => unknown) => operation(tx)) };
    const service = new CoreService(prisma as unknown as PrismaService);

    await expect(service.addPayment({ id: 'user-1' } as never, order.id, { amount: 10.01, method: 'Efectivo' })).rejects.toThrow(/supera el saldo/i);
    tx.order.findUnique.mockResolvedValue({ ...order, status: 'CANCELLED', paidCents: 0 });
    await expect(service.addPayment({ id: 'user-1' } as never, order.id, { amount: 1, method: 'Efectivo' })).rejects.toThrow(/pedido cancelado/i);
    tx.order.findUnique.mockResolvedValue({ ...order, paidCents: 0 });
    await expect(service.addPayment({ id: 'user-1' } as never, order.id, { amount: 1, method: 'Efectivo', paidAt: 'not-a-date' })).rejects.toThrow(/fecha de pago/i);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('returns a client error for malformed order line objects', async () => {
    const service = new CoreService({} as PrismaService);
    await expect(service.createOrder({ id: 'user-1' } as never, { customerId: 'customer-1', lines: [null] })).rejects.toThrow(/línea del pedido/i);
  });
});
