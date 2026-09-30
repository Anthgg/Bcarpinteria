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

  it('rejects a kerf above the single 100 mm limit without saving', async () => {
    const prisma = { $transaction: jest.fn(), appSetting: { upsert: jest.fn() } };
    const service = new CoreService(prisma as unknown as PrismaService);
    await expect(service.updateSettings({ id: 'user-1' } as never, { kerfMm: 101 })).rejects.toThrow('entre 0 y 100 mm');
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('CoreService material availability', () => {
  it('aggregates pieces, thicknesses, largest piece and reservations with a fixed number of queries', async () => {
    const prisma = {
      inventoryItem: { findMany: jest.fn().mockResolvedValue([
        { id: 'wood', code: 'W', name: 'A013', type: 'MATERIAL', unit: 'TABLON', stock: '0', controlsStock: true, productionConsumable: false, requiresDimensions: true },
        { id: 'screws', code: 'S', name: 'Tornillos', type: 'CONSUMIBLE', unit: 'UNIDAD', stock: '120', controlsStock: true, productionConsumable: true, requiresDimensions: false },
      ]) },
      materialPiece: {
        groupBy: jest.fn().mockResolvedValue([
          { materialId: 'wood', state: 'AVAILABLE', _count: { _all: 2 } }, { materialId: 'wood', state: 'RESERVED', _count: { _all: 1 } }, { materialId: 'wood', state: 'CONSUMED', _count: { _all: 1 } },
        ]),
        findMany: jest.fn().mockResolvedValue([
          { materialId: 'wood', code: 'RET-1', kind: 'OFFCUT', lengthMm: 60, widthMm: 447, thicknessMm: 18 },
          { materialId: 'wood', code: 'RET-8', kind: 'OFFCUT', lengthMm: 471, widthMm: 1200, thicknessMm: 18 },
        ]),
      },
      itemReservation: { groupBy: jest.fn().mockResolvedValue([{ itemId: 'screws', _sum: { quantity: '16' } }]) },
      appSetting: { findUnique: jest.fn().mockResolvedValue({ key: 'low_stock_threshold', value: '5' }) },
    };
    const service = new CoreService(prisma as unknown as PrismaService);

    const result = await service.listMaterialAvailability();

    expect(result.lowStockThreshold).toBe(5);
    expect(result.items[0]).toMatchObject({
      id: 'wood', physicalPieces: 4, availablePieces: 2, reservedPieces: 1, availableThicknessesMm: [18],
      largestAvailablePiece: { code: 'RET-8', lengthMm: 471, widthMm: 1200, thicknessMm: 18 },
    });
    expect(result.items[1]).toMatchObject({ id: 'screws', stock: 120, reservedQuantity: 16, availablePieces: 0 });
    expect(prisma.materialPiece.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { materialId: { in: ['wood', 'screws'] }, state: 'AVAILABLE' } }));
    expect(prisma.materialPiece.findMany).toHaveBeenCalledTimes(1);
  });
});
