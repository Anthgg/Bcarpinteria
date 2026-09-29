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
