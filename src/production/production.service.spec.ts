import { AppRole, ProductionStage, ProductionStatus, PieceState, ReservationStatus } from '@prisma/client';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthUser } from '../common/auth';
import { ProductionService } from './production.service';

const actor: AuthUser = { id: 'user-1', email: 'admin@local.test', name: 'Admin', role: AppRole.ADMIN };

function fixture(reservedCount = 1) {
  const job = {
    id: 'job-1', orderId: 'order-1', orderLineId: 'line-1', stage: ProductionStage.ORDER_RECEIVED,
    status: ProductionStatus.ACTIVE, progress: 0, orderLine: { quantity: 1 },
  };
  const tx = {
    productionJob: { findUnique: jest.fn().mockResolvedValue(job), update: jest.fn().mockResolvedValue(job), count: jest.fn().mockResolvedValue(0) },
    cuttingPlan: {
      findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', jobId: job.id, confirmedAt: null, result: { boards: [{ id: 'piece-1', code: 'TAB-00001' }], unplaced: [] } }),
      update: jest.fn().mockResolvedValue({}),
    },
    materialPiece: { updateMany: jest.fn().mockResolvedValue({ count: reservedCount }), update: jest.fn().mockResolvedValue({}) },
    pieceReservation: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    itemReservation: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    inventoryItem: { update: jest.fn().mockResolvedValue({}) },
    jobComponent: { findMany: jest.fn().mockResolvedValue([]) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
    productionStageHistory: { create: jest.fn().mockResolvedValue({}) },
    order: { update: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: jest.fn((work: (transaction: typeof tx) => unknown) => work(tx)) };
  return { tx, service: new ProductionService(prisma as never, {} as never) };
}

describe('ProductionService material reservation', () => {
  it('rejects malformed material configuration before deleting prior rows', async () => {
    const prisma = {
      productionJob: { findUnique: jest.fn().mockResolvedValue({
        id: 'job-1', status: ProductionStatus.ACTIVE, progress: 0,
      }) },
      $transaction: jest.fn(),
    };
    const service = new ProductionService(prisma as never, {} as never);

    await expect(service.configure(actor, 'job-1', { components: 'bad', pieces: [] })).rejects.toThrow('deben enviarse como listas');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reserves only available physical boards and records the reservation', async () => {
    const { tx, service } = fixture();

    const result = await service.confirmPlan(actor, 'job-1', 'plan-1');

    expect(result).toEqual({ ok: true, reservedPieces: 1, reservedComponentTypes: 0 });
    expect(tx.materialPiece.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['piece-1'] }, state: PieceState.AVAILABLE }, data: { state: PieceState.RESERVED },
    });
    expect(tx.pieceReservation.createMany).toHaveBeenCalledWith({ data: [{ jobId: 'job-1', pieceId: 'piece-1' }] });
    expect(tx.productionJob.update).toHaveBeenCalledWith(expect.objectContaining({ data: { stage: ProductionStage.MATERIALS_RESERVED, progress: 15 } }));
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'order-1' }, data: { status: 'IN_PRODUCTION' } });
  });

  it('rejects a board that another production reserved first', async () => {
    const { tx, service } = fixture(0);

    await expect(service.confirmPlan(actor, 'job-1', 'plan-1')).rejects.toThrow('Una o más tablas ya no están disponibles.');
    expect(tx.pieceReservation.createMany).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('reactivates an existing released reservation when the same job reserves the board again', async () => {
    const { tx, service } = fixture();
    tx.pieceReservation.findMany.mockResolvedValue([
      { id: 'reservation-1', pieceId: 'piece-1', status: ReservationStatus.RELEASED },
    ]);

    await service.confirmPlan(actor, 'job-1', 'plan-1');

    expect(tx.pieceReservation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['reservation-1'] }, status: ReservationStatus.RELEASED },
      data: { status: ReservationStatus.RESERVED, reservedAt: expect.any(Date), consumedAt: null },
    });
    expect(tx.pieceReservation.createMany).not.toHaveBeenCalled();
  });

  it('records compensating movements when reservations are released', async () => {
    const { tx, service } = fixture();
    tx.productionJob.findUnique.mockResolvedValue({
      id: 'job-1', orderId: 'order-1', stage: ProductionStage.MATERIALS_RESERVED,
      status: ProductionStatus.ACTIVE, progress: 15, orderLine: { quantity: 1 },
    });
    tx.pieceReservation.findMany.mockResolvedValue([
      { id: 'piece-reservation-1', pieceId: 'piece-1', status: ReservationStatus.RESERVED },
    ]);
    tx.itemReservation.findMany.mockResolvedValue([
      { id: 'item-reservation-1', itemId: 'item-1', quantity: 2, status: ReservationStatus.RESERVED },
    ]);
    tx.productionJob.count.mockResolvedValue(0);

    const result = await service.releaseReservations(actor, 'job-1');

    expect(result).toEqual({ releasedPieces: 1, releasedItems: 1 });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith({ data: {
      pieceId: 'piece-1', action: 'PIECE_RESERVATION_RELEASED',
      note: 'Reserva liberada en producción job-1', userId: actor.id,
    } });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith({ data: {
      itemId: 'item-1', quantity: 2, action: 'ITEM_RESERVATION_RELEASED',
      note: 'Reserva liberada en producción job-1', userId: actor.id,
    } });
  });

  it('does not allow skipping production stages', async () => {
    const { tx, service } = fixture();

    await expect(service.advanceStage(actor, 'job-1', ProductionStage.ASSEMBLY)).rejects.toThrow('Avanza una etapa a la vez');
    expect(tx.productionJob.update).not.toHaveBeenCalled();
  });
});

describe('ProductionService cutting simulation', () => {
  const material = { id: 'mat-1', name: 'A013 Madera', unit: 'UNIDAD', stock: '0' };
  function simulationFixture(requirements: Array<Record<string, unknown>>, pieces: Array<Record<string, unknown>>, counts: Array<{ state: string; count: number }>) {
    const prisma = {
      productionJob: { findUnique: jest.fn().mockResolvedValue({
        id: 'job-1', stage: ProductionStage.ORDER_RECEIVED, status: ProductionStatus.ACTIVE, orderLine: { quantity: 1 },
        requirements: requirements.map((row) => ({ materialId: material.id, material, ...row })),
      }) },
      appSetting: { findUnique: jest.fn().mockResolvedValue({ key: 'cutting_kerf_mm', value: '3' }) },
      materialPiece: {
        findMany: jest.fn().mockResolvedValue(pieces.map((row) => ({ materialId: material.id, material: { name: material.name }, ...row }))),
        groupBy: jest.fn().mockResolvedValue(counts.map(({ state, count }) => ({ materialId: material.id, state, _count: { _all: count } }))),
      },
      cuttingPlan: { create: jest.fn().mockResolvedValue({ id: 'plan-1' }) },
    };
    const core = { audit: jest.fn().mockResolvedValue(undefined) };
    return { prisma, core, service: new ProductionService(prisma as never, core as never) };
  }

  it('reads only AVAILABLE pieces, keeps material and dimensions, and persists a plan without touching stock', async () => {
    const { prisma, core, service } = simulationFixture(
      [{ id: 'req-1', label: 'Cubierta', lengthMm: 1800, widthMm: 900, thicknessMm: 18, quantity: 1 }],
      [{ id: 'piece-1', code: 'TAB-00005', lengthMm: 2400, widthMm: 1200, thicknessMm: 18, kind: 'BOARD' }],
      [{ state: 'AVAILABLE', count: 1 }],
    );

    const result = await service.simulate(actor, 'job-1', {});

    expect(prisma.materialPiece.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { materialId: { in: ['mat-1'] }, state: PieceState.AVAILABLE } }));
    expect(result.boards[0]).toMatchObject({ code: 'TAB-00005', materialId: 'mat-1', lengthMm: 2400, widthMm: 1200, thicknessMm: 18 });
    expect(result.boards[0].placements[0]).toMatchObject({ label: 'Cubierta', lengthMm: 1800, widthMm: 900 });
    expect(result.diagnostics).toMatchObject({ requestedParts: 1, placedParts: 1, primaryReason: null });
    expect(prisma.cuttingPlan.create).toHaveBeenCalledTimes(1);
    expect(prisma.cuttingPlan.create.mock.calls[0][0].data).toMatchObject({ jobId: 'job-1', strategy: 'OFFCUTS_FIRST', kerfMm: 3 });
    // El mock no define update/updateMany/reservas: cualquier escritura de inventario lanzaría un error.
    expect(Object.keys(prisma.materialPiece)).toEqual(['findMany', 'groupBy']);
    expect(core.audit).toHaveBeenCalledWith(actor.id, 'CUTTING_SIMULATED', 'CuttingPlan', 'plan-1', expect.any(Object));
  });

  it('returns a backend diagnosis for unplaced pieces using every piece state and loose stock', async () => {
    const { service } = simulationFixture(
      [{ id: 'req-1', label: 'dwfe', lengthMm: 233, widthMm: 34, thicknessMm: 23, quantity: 15 }],
      [{ id: 'piece-8', code: 'RET-00008', lengthMm: 471, widthMm: 1200, thicknessMm: 18, kind: 'OFFCUT' }],
      [{ state: 'AVAILABLE', count: 1 }, { state: 'CONSUMED', count: 1 }],
    );

    const result = await service.simulate(actor, 'job-1', { strategy: 'OFFCUTS_FIRST' });

    expect(result.unplaced).toHaveLength(15);
    expect(result.diagnostics.primaryReason).toBe('THICKNESS_MISMATCH');
    expect(result.diagnostics.materials[0]).toMatchObject({ materialName: 'A013 Madera', physicalPieces: 2, availablePieces: 1, piecesByState: { AVAILABLE: 1, CONSUMED: 1 } });
    expect(result.diagnostics.groups).toEqual([expect.objectContaining({ label: 'dwfe', pending: 15, reason: 'THICKNESS_MISMATCH' })]);
  });

  it('rejects confirming a plan that still has unplaced pieces', async () => {
    const { tx, service } = fixture();
    tx.cuttingPlan.findFirst.mockResolvedValue({ id: 'plan-1', jobId: 'job-1', confirmedAt: null, result: { boards: [], unplaced: [{ label: 'Pata' }] } });

    await expect(service.confirmPlan(actor, 'job-1', 'plan-1')).rejects.toThrow('piezas sin ubicar');
    expect(tx.materialPiece.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the confirm-cut flow: RESERVED pieces become CONSUMED and leftovers PENDING_DISPOSITION', async () => {
    const { tx, service } = fixture();
    tx.productionJob.findUnique.mockResolvedValue({ id: 'job-1', orderId: 'order-1', stage: ProductionStage.MATERIALS_RESERVED, status: ProductionStatus.ACTIVE, progress: 15 });
    tx.cuttingPlan.findFirst.mockResolvedValue({ id: 'plan-1', result: { unplaced: [], boards: [{
      id: 'piece-1', code: 'TAB-00006', materialId: 'mat-1',
      leftovers: [{ xMm: 453, yMm: 0, lengthMm: 600, widthMm: 447, thicknessMm: 18 }],
    }] } });
    Object.assign(tx.pieceReservation, { findFirst: jest.fn().mockResolvedValue({ id: 'reservation-1' }) });
    Object.assign(tx.materialPiece, { create: jest.fn().mockResolvedValue({ id: 'offcut-1' }) });
    Object.assign(tx, { numberSequence: { upsert: jest.fn().mockResolvedValue({ value: 11 }) } });
    jest.spyOn(service, 'getJob').mockResolvedValue({} as never);

    const result = await service.confirmCut(actor, 'job-1');

    expect(result.offcutsCreated).toBe(1);
    expect(tx.materialPiece.update).toHaveBeenCalledWith({ where: { id: 'piece-1' }, data: { state: PieceState.CONSUMED } });
    expect((tx.materialPiece as unknown as { create: jest.Mock }).create).toHaveBeenCalledWith({ data: expect.objectContaining({
      code: 'RET-00011', kind: 'OFFCUT', state: PieceState.PENDING_DISPOSITION, originPieceId: 'piece-1', lengthMm: 600, widthMm: 447,
    }) });
  });
});

describe('ProductionService photo uploads', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carpinteria-photo-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('removes an uploaded image when photo metadata cannot be persisted', async () => {
    const filename = '550e8400-e29b-41d4-a716-446655440000.png';
    const filePath = join(directory, filename);
    await writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const prisma = {
      productionJob: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', orderId: 'order-1' }) },
      productionPhoto: { create: jest.fn().mockRejectedValue(new Error('database unavailable')) },
    };
    const service = new ProductionService(prisma as never, {} as never);
    const file = { filename, destination: directory, mimetype: 'image/png' } as Express.Multer.File;

    await expect(service.addPhoto(actor, 'job-1', file, 'Front view')).rejects.toThrow('database unavailable');
    await expect(access(filePath)).rejects.toThrow();
  });

  it('removes an uploaded image when its caption is invalid', async () => {
    const filename = '550e8400-e29b-41d4-a716-446655440001.png';
    const filePath = join(directory, filename);
    await writeFile(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const prisma = {
      productionJob: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', orderId: 'order-1' }) },
      productionPhoto: { create: jest.fn() },
    };
    const service = new ProductionService(prisma as never, {} as never);
    const file = { filename, destination: directory, mimetype: 'image/png' } as Express.Multer.File;

    await expect(service.addPhoto(actor, 'job-1', file, 'x'.repeat(181))).rejects.toThrow('Descripción');
    await expect(access(filePath)).rejects.toThrow();
    expect(prisma.productionPhoto.create).not.toHaveBeenCalled();
  });
});
