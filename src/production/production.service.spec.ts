import { AppRole, ProductionStage, ProductionStatus, PieceState } from '@prisma/client';
import type { AuthUser } from '../common/auth';
import { ProductionService } from './production.service';

const actor: AuthUser = { id: 'user-1', email: 'admin@local.test', name: 'Admin', role: AppRole.ADMIN };

function fixture(reservedCount = 1) {
  const job = {
    id: 'job-1', orderId: 'order-1', orderLineId: 'line-1', stage: ProductionStage.ORDER_RECEIVED,
    status: ProductionStatus.ACTIVE, progress: 0, orderLine: { quantity: 1 },
  };
  const tx = {
    productionJob: { findUnique: jest.fn().mockResolvedValue(job), update: jest.fn().mockResolvedValue(job) },
    cuttingPlan: {
      findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', jobId: job.id, confirmedAt: null, result: { boards: [{ id: 'piece-1', code: 'TAB-00001' }], unplaced: [] } }),
      update: jest.fn().mockResolvedValue({}),
    },
    materialPiece: { updateMany: jest.fn().mockResolvedValue({ count: reservedCount }) },
    pieceReservation: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
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

  it('does not allow skipping production stages', async () => {
    const { tx, service } = fixture();

    await expect(service.advanceStage(actor, 'job-1', ProductionStage.ASSEMBLY)).rejects.toThrow('Avanza una etapa a la vez');
    expect(tx.productionJob.update).not.toHaveBeenCalled();
  });
});
