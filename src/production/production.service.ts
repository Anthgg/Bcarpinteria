import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NoteVisibility,
  OrderStatus,
  PieceState,
  Prisma,
  ProductionStage,
  ProductionStatus,
  ReservationStatus,
} from '@prisma/client';
import { readFile, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { PrismaService } from '../prisma.service';
import { AuthUser } from '../common/auth';
import { CoreService } from '../core/core.service';
import { CutBoard, CutRequirement, CutStrategy, CuttingResult, MAX_KERF_MM, MaterialStockContext, suggestCuts } from './cutting-engine';

const PROGRESS: Record<ProductionStage, number> = {
  ORDER_RECEIVED: 0,
  MATERIALS_RESERVED: 15,
  CUTTING: 30,
  ASSEMBLY: 50,
  SANDING: 65,
  FINISHING: 80,
  QUALITY_CONTROL: 90,
  READY: 100,
};
const STAGES = Object.values(ProductionStage);
const text = (value: unknown, label: string, max = 500) => {
  const result = String(value ?? '').trim();
  if (result.length < 1 || result.length > max) throw new BadRequestException(`${label} debe tener entre 1 y ${max} caracteres.`);
  return result;
};

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: CoreService,
  ) {}

  private async requireJob(id: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    const job = await tx.productionJob.findUnique({ where: { id }, include: { order: true, orderLine: true } });
    if (!job) throw new NotFoundException('Producción no encontrada.');
    return job;
  }

  async listJobs() {
    return this.prisma.productionJob.findMany({
      include: {
        order: { select: { id: true, code: true, status: true, customer: { select: { name: true } } } },
        orderLine: { select: { name: true, quantity: true } },
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async getJob(id: string) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id },
      include: {
        order: { include: { customer: true } },
        orderLine: true,
        components: { include: { material: true } },
        requirements: { include: { material: true } },
        stageHistory: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'asc' } },
        notes: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
        incidents: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
        photos: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
        cutPlans: { orderBy: { createdAt: 'desc' }, take: 5 },
        pieceReservations: { include: { piece: { include: { material: true } } } },
        itemReservations: { include: { item: true } },
      },
    });
    if (!job) throw new NotFoundException('Producción no encontrada.');
    return job;
  }

  async configure(actor: AuthUser, jobId: string, input: Record<string, unknown>) {
    const job = await this.requireJob(jobId);
    if (job.status !== ProductionStatus.ACTIVE || job.progress > PROGRESS.ORDER_RECEIVED) {
      throw new ConflictException('La selección se define antes de reservar los materiales.');
    }
    if (!Array.isArray(input.components) || !Array.isArray(input.pieces)) throw new BadRequestException('Componentes y piezas deben enviarse como listas.');
    if (input.components.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
      || input.pieces.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new BadRequestException('Cada componente y pieza debe ser un objeto válido.');
    }
    const components = input.components as Record<string, unknown>[];
    const pieces = input.pieces as Record<string, unknown>[];
    if (components.length > 100 || pieces.length > 100) throw new BadRequestException('El plan excede el máximo de componentes.');
    const componentRows: Array<{ label: string; materialId: string; quantity: Prisma.Decimal; unit: string }> = [];
    for (const row of components) {
      const item = await this.prisma.inventoryItem.findUnique({ where: { id: String(row.materialId ?? '') } });
      if (!item?.active) throw new NotFoundException('Selecciona un material o consumible activo.');
      if (!item.productionConsumable) throw new BadRequestException('Marca el artículo como consumible de producción antes de seleccionarlo.');
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw new BadRequestException('Cantidad de material inválida.');
      componentRows.push({ label: text(row.label ?? item.name, 'Nombre del componente', 120), materialId: item.id, quantity: new Prisma.Decimal(quantity), unit: item.unit });
    }
    const pieceRows: Array<{ label: string; materialId: string; lengthMm: number; widthMm: number; thicknessMm: number; quantity: number }> = [];
    for (const row of pieces) {
      const item = await this.prisma.inventoryItem.findUnique({ where: { id: String(row.materialId ?? '') } });
      if (!item?.active || item.type !== 'MATERIAL') throw new NotFoundException('Cada pieza requiere un material dimensional activo.');
      const dimensions = ['lengthMm', 'widthMm', 'thicknessMm'] as const;
      const values = Object.fromEntries(dimensions.map((field) => [field, Number(row[field])])) as Record<typeof dimensions[number], number>;
      if (dimensions.some((field) => !Number.isSafeInteger(values[field]) || values[field] <= 0 || values[field] > 10_000_000)) throw new BadRequestException('Las medidas de cada pieza deben ser milímetros enteros mayores que cero.');
      const quantity = Number(row.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10000) throw new BadRequestException('La cantidad de piezas debe ser un entero entre 1 y 10000.');
      pieceRows.push({ label: text(row.label, 'Nombre de la pieza', 120), materialId: item.id, ...values, quantity });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.jobComponent.deleteMany({ where: { jobId } });
      await tx.requiredPiece.deleteMany({ where: { jobId } });
      if (componentRows.length) await tx.jobComponent.createMany({ data: componentRows.map((row) => ({ ...row, jobId })) });
      if (pieceRows.length) await tx.requiredPiece.createMany({ data: pieceRows.map((row) => ({ ...row, jobId })) });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PRODUCTION_MATERIALS_CONFIGURED', entity: 'ProductionJob', entityId: jobId, metadata: { components: componentRows.length, pieces: pieceRows.length } } });
    });
    return this.getJob(jobId);
  }

  async simulate(actor: AuthUser, jobId: string, input: Record<string, unknown>) {
    const job = await this.prisma.productionJob.findUnique({
      where: { id: jobId },
      include: { orderLine: true, requirements: { include: { material: true } } },
    });
    if (!job) throw new NotFoundException('Producción no encontrada.');
    if (job.status !== ProductionStatus.ACTIVE || job.stage !== ProductionStage.ORDER_RECEIVED) {
      throw new ConflictException('Solo se calcula un plan para una producción activa antes de reservar.');
    }
    if (!job.requirements.length) throw new BadRequestException('Define las piezas necesarias antes de calcular los cortes.');
    const strategy = String(input.strategy ?? 'OFFCUTS_FIRST') as CutStrategy;
    if (!['OFFCUTS_FIRST', 'FULL_BOARDS_FIRST'].includes(strategy)) throw new BadRequestException('Estrategia de corte inválida.');
    const configuredKerf = Number((await this.prisma.appSetting.findUnique({ where: { key: 'cutting_kerf_mm' } }))?.value ?? 3);
    const kerfMm = input.kerfMm === undefined ? configuredKerf : Number(input.kerfMm);
    if (!Number.isSafeInteger(kerfMm) || kerfMm < 0 || kerfMm > MAX_KERF_MM) {
      throw new BadRequestException(`El ancho de corte debe ser un número entero entre 0 y ${MAX_KERF_MM} mm.`);
    }
    const materialIds = [...new Set(job.requirements.map((piece) => piece.materialId))];
    const [available, pieceCounts] = await Promise.all([
      this.prisma.materialPiece.findMany({
        where: { materialId: { in: materialIds }, state: PieceState.AVAILABLE },
        include: { material: { select: { name: true } } },
      }),
      this.prisma.materialPiece.groupBy({
        by: ['materialId', 'state'], where: { materialId: { in: materialIds } }, _count: { _all: true },
      }),
    ]);
    // Contexto de solo lectura para explicar piezas sin ubicar (stock suelto vs. piezas físicas por estado).
    const stock: MaterialStockContext[] = materialIds.map((materialId) => {
      const material = job.requirements.find((piece) => piece.materialId === materialId)!.material;
      return {
        materialId, materialName: material.name, unit: material.unit, looseStock: Number(material.stock),
        piecesByState: Object.fromEntries(pieceCounts.filter((row) => row.materialId === materialId).map((row) => [row.state, row._count._all])),
      };
    });
    const boards: CutBoard[] = available.map((piece) => ({
      id: piece.id, code: piece.code, materialId: piece.materialId, materialName: piece.material.name,
      lengthMm: piece.lengthMm, widthMm: piece.widthMm, thicknessMm: piece.thicknessMm, kind: piece.kind,
    }));
    const requirements: CutRequirement[] = job.requirements.map((piece) => ({
      id: piece.id, label: piece.label, materialId: piece.materialId,
      lengthMm: piece.lengthMm, widthMm: piece.widthMm, thicknessMm: piece.thicknessMm,
      quantity: piece.quantity * job.orderLine.quantity,
    }));
    let result: CuttingResult;
    try {
      result = suggestCuts(requirements, boards, kerfMm, strategy, stock);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const record = await this.prisma.cuttingPlan.create({
      data: { jobId, strategy, kerfMm, result: result as unknown as Prisma.InputJsonValue, createdBy: actor.id },
    });
    await this.core.audit(actor.id, 'CUTTING_SIMULATED', 'CuttingPlan', record.id, { jobId, strategy, boards: result.summary.boardsUsed });
    return { id: record.id, ...result };
  }

  async confirmPlan(actor: AuthUser, jobId: string, planId: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
      const job = await tx.productionJob.findUnique({ where: { id: jobId }, include: { orderLine: true } });
      if (!job) throw new NotFoundException('Producción no encontrada.');
      if (job.status !== ProductionStatus.ACTIVE || job.stage !== ProductionStage.ORDER_RECEIVED) throw new ConflictException('La producción no está lista para reservar.');
      const plan = await tx.cuttingPlan.findFirst({ where: { id: planId, jobId } });
      if (!plan) throw new NotFoundException('Plan de corte no encontrado.');
      if (plan.confirmedAt) throw new ConflictException('El plan ya fue confirmado.');
      const result = plan.result as unknown as CuttingResult;
      if (result.unplaced.length) throw new ConflictException('El plan tiene piezas sin ubicar; resuelve la disponibilidad antes de reservar.');
      const pieceIds = result.boards.map((board) => board.id);
      if (pieceIds.length) {
        const updated = await tx.materialPiece.updateMany({ where: { id: { in: pieceIds }, state: PieceState.AVAILABLE }, data: { state: PieceState.RESERVED } });
        if (updated.count !== pieceIds.length) throw new ConflictException('Una o más tablas ya no están disponibles. Simula de nuevo.');
        const priorReservations = await tx.pieceReservation.findMany({
          where: { jobId, pieceId: { in: pieceIds } },
          select: { id: true, pieceId: true, status: true },
        });
        if (priorReservations.some((reservation) => reservation.status !== ReservationStatus.RELEASED)) {
          throw new ConflictException('Una o más tablas ya tienen una reserva registrada para esta producción.');
        }
        const priorPieceIds = new Set(priorReservations.map((reservation) => reservation.pieceId));
        if (priorReservations.length) {
          await tx.pieceReservation.updateMany({
            where: { id: { in: priorReservations.map((reservation) => reservation.id) }, status: ReservationStatus.RELEASED },
            data: { status: ReservationStatus.RESERVED, reservedAt: new Date(), consumedAt: null },
          });
        }
        const newPieceIds = pieceIds.filter((pieceId) => !priorPieceIds.has(pieceId));
        if (newPieceIds.length) await tx.pieceReservation.createMany({ data: newPieceIds.map((pieceId) => ({ jobId, pieceId })) });
        for (const pieceId of pieceIds) await tx.inventoryMovement.create({ data: { pieceId, action: 'PIECE_RESERVED', note: `Reserva ${job.id}`, userId: actor.id } });
      }
      const components = await tx.jobComponent.findMany({ where: { jobId }, include: { material: { select: { controlsStock: true } } } });
      const totals = new Map<string, number>();
      for (const component of components) {
        if (!component.material.controlsStock) continue;
        totals.set(component.materialId, (totals.get(component.materialId) ?? 0) + Number(component.quantity) * job.orderLine.quantity);
      }
      for (const [itemId, quantity] of totals) {
        const updated = await tx.inventoryItem.updateMany({ where: { id: itemId, stock: { gte: quantity } }, data: { stock: { decrement: quantity } } });
        if (updated.count !== 1) throw new ConflictException('No hay stock suficiente de uno de los consumibles seleccionados.');
        await tx.itemReservation.create({ data: { jobId, itemId, quantity: new Prisma.Decimal(quantity) } });
        await tx.inventoryMovement.create({ data: { itemId, quantity: new Prisma.Decimal(quantity), action: 'ITEM_RESERVED', note: `Reserva de producción ${job.id}`, userId: actor.id } });
      }
      await tx.cuttingPlan.update({ where: { id: planId }, data: { confirmedAt: new Date() } });
      await tx.productionJob.update({ where: { id: jobId }, data: { stage: ProductionStage.MATERIALS_RESERVED, progress: Math.max(job.progress, PROGRESS.MATERIALS_RESERVED) } });
      await tx.productionStageHistory.create({ data: { jobId, stage: ProductionStage.MATERIALS_RESERVED, progress: Math.max(job.progress, PROGRESS.MATERIALS_RESERVED), userId: actor.id } });
      await tx.order.update({ where: { id: job.orderId }, data: { status: OrderStatus.IN_PRODUCTION } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PRODUCTION_RESERVED', entity: 'ProductionJob', entityId: jobId, metadata: { planId, pieces: pieceIds.length, components: totals.size } } });
      return { ok: true, reservedPieces: pieceIds.length, reservedComponentTypes: totals.size };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictException('Una o más tablas ya no están disponibles. Simula de nuevo.');
      }
      throw error;
    }
  }

  private async nextPieceCode(tx: Prisma.TransactionClient, kind: 'piece' | 'offcut') {
    const sequence = await tx.numberSequence.upsert({
      where: { name: kind }, create: { name: kind, value: 1 }, update: { value: { increment: 1 } },
    });
    return `${kind === 'piece' ? 'TAB' : 'RET'}-${String(sequence.value).padStart(5, '0')}`;
  }

  async confirmCut(actor: AuthUser, jobId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const job = await tx.productionJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundException('Producción no encontrada.');
      if (job.status !== ProductionStatus.ACTIVE) throw new ConflictException('Reanuda la producción antes de confirmar el corte.');
      if (job.stage !== ProductionStage.MATERIALS_RESERVED) throw new ConflictException('Reserva los materiales antes de confirmar el corte.');
      const plan = await tx.cuttingPlan.findFirst({ where: { jobId, confirmedAt: { not: null } }, orderBy: { createdAt: 'desc' } });
      if (!plan) throw new ConflictException('No existe un plan confirmado para esta producción.');
      const planResult = plan.result as unknown as CuttingResult;
      if (planResult.unplaced.length) throw new ConflictException('No se puede confirmar un corte con piezas sin ubicar.');
      let offcuts = 0;
      for (const board of planResult.boards) {
        const reservation = await tx.pieceReservation.findFirst({ where: { jobId, pieceId: board.id, status: ReservationStatus.RESERVED } });
        if (!reservation) throw new ConflictException(`La pieza ${board.code} ya no está reservada.`);
        await tx.materialPiece.update({ where: { id: board.id }, data: { state: PieceState.CONSUMED } });
        await tx.pieceReservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.CONSUMED, consumedAt: new Date() } });
        await tx.inventoryMovement.create({ data: { pieceId: board.id, action: 'PIECE_CONSUMED', note: `Corte confirmado en producción ${jobId}`, userId: actor.id } });
        for (const scrap of board.leftovers) {
          if (scrap.lengthMm < 1 || scrap.widthMm < 1) continue;
          const piece = await tx.materialPiece.create({ data: {
            code: await this.nextPieceCode(tx, 'offcut'), materialId: board.materialId,
            lengthMm: scrap.lengthMm, widthMm: scrap.widthMm, thicknessMm: scrap.thicknessMm,
            kind: 'OFFCUT', state: PieceState.PENDING_DISPOSITION, originPieceId: board.id,
          } });
          await tx.inventoryMovement.create({ data: { itemId: board.materialId, pieceId: piece.id, quantity: 1, action: 'OFFCUT_CREATED_PENDING_DISPOSITION', note: `Retazo generado por ${board.code}`, userId: actor.id } });
          offcuts += 1;
        }
      }
      const reservations = await tx.itemReservation.findMany({ where: { jobId, status: ReservationStatus.RESERVED } });
      for (const reservation of reservations) {
        await tx.itemReservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.CONSUMED } });
        await tx.inventoryMovement.create({ data: { itemId: reservation.itemId, quantity: reservation.quantity, action: 'PRODUCTION_CONSUMED', note: `Consumo confirmado en producción ${jobId}`, userId: actor.id } });
      }
      await tx.productionJob.update({ where: { id: jobId }, data: { stage: ProductionStage.CUTTING, progress: Math.max(job.progress, PROGRESS.CUTTING) } });
      await tx.productionStageHistory.create({ data: { jobId, stage: ProductionStage.CUTTING, progress: Math.max(job.progress, PROGRESS.CUTTING), userId: actor.id, note: 'Corte real confirmado' } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'CUT_CONFIRMED', entity: 'ProductionJob', entityId: jobId, metadata: { planId: plan.id, offcuts } } });
      return { jobId, offcuts, orderId: job.orderId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { ok: true, offcutsCreated: result.offcuts, job: await this.getJob(jobId) };
  }

  async releaseReservations(actor: AuthUser, jobId: string) {
    return this.prisma.$transaction(async (tx) => {
      const job = await this.requireJob(jobId, tx);
      if (job.progress > PROGRESS.MATERIALS_RESERVED) throw new ConflictException('No se pueden liberar materiales después de confirmar el corte.');
      const pieces = await tx.pieceReservation.findMany({ where: { jobId, status: ReservationStatus.RESERVED } });
      for (const reservation of pieces) {
        await tx.materialPiece.update({ where: { id: reservation.pieceId }, data: { state: PieceState.AVAILABLE } });
        await tx.pieceReservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.RELEASED } });
        await tx.inventoryMovement.create({ data: {
          pieceId: reservation.pieceId, action: 'PIECE_RESERVATION_RELEASED',
          note: `Reserva liberada en producción ${jobId}`, userId: actor.id,
        } });
      }
      const items = await tx.itemReservation.findMany({ where: { jobId, status: ReservationStatus.RESERVED } });
      for (const reservation of items) {
        await tx.inventoryItem.update({ where: { id: reservation.itemId }, data: { stock: { increment: reservation.quantity } } });
        await tx.itemReservation.update({ where: { id: reservation.id }, data: { status: ReservationStatus.RELEASED } });
        await tx.inventoryMovement.create({ data: {
          itemId: reservation.itemId, quantity: reservation.quantity, action: 'ITEM_RESERVATION_RELEASED',
          note: `Reserva liberada en producción ${jobId}`, userId: actor.id,
        } });
      }
      await tx.productionJob.update({ where: { id: jobId }, data: { stage: ProductionStage.ORDER_RECEIVED, progress: 0 } });
      const otherStartedJobs = await tx.productionJob.count({ where: { orderId: job.orderId, id: { not: jobId }, progress: { gt: 0 } } });
      if (otherStartedJobs === 0) await tx.order.update({ where: { id: job.orderId }, data: { status: OrderStatus.CONFIRMED } });
      await tx.productionStageHistory.create({ data: { jobId, stage: ProductionStage.ORDER_RECEIVED, progress: 0, userId: actor.id, note: 'Reserva liberada' } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PRODUCTION_RESERVATION_RELEASED', entity: 'ProductionJob', entityId: jobId, metadata: { pieces: pieces.length, items: items.length } } });
      return { releasedPieces: pieces.length, releasedItems: items.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async advanceStage(actor: AuthUser, jobId: string, stageValue: unknown, noteValue?: unknown) {
    const stage = String(stageValue) as ProductionStage;
    if (!STAGES.includes(stage)) throw new BadRequestException('Etapa de producción inválida.');
    const note = noteValue == null ? null : text(noteValue, 'Nota', 500);
    const result = await this.prisma.$transaction(async (tx) => {
      const job = await tx.productionJob.findUnique({ where: { id: jobId } });
      if (!job) throw new NotFoundException('Producción no encontrada.');
      if (job.status === ProductionStatus.COMPLETED || job.status === ProductionStatus.PAUSED) throw new ConflictException('Reanuda una producción activa antes de avanzar.');
      if (STAGES.indexOf(stage) !== STAGES.indexOf(job.stage) + 1) throw new ConflictException('Avanza una etapa a la vez para conservar el historial de producción.');
      const progress = Math.max(job.progress, PROGRESS[stage]);
      await tx.productionJob.update({ where: { id: jobId }, data: {
        stage, progress,
        ...(stage === ProductionStage.READY ? { status: ProductionStatus.COMPLETED, completedAt: new Date() } : {}),
      } });
      await tx.productionStageHistory.create({ data: { jobId, stage, progress, userId: actor.id, note } });
      if (stage === ProductionStage.READY) {
        const remaining = await tx.productionJob.count({ where: { orderId: job.orderId, id: { not: jobId }, status: { not: ProductionStatus.COMPLETED } } });
        if (remaining === 0) await tx.order.update({ where: { id: job.orderId }, data: { status: OrderStatus.READY } });
      }
      await tx.auditLog.create({ data: { userId: actor.id, action: 'PRODUCTION_STAGE_CHANGED', entity: 'ProductionJob', entityId: jobId, metadata: { from: job.stage, to: stage, progress } } });
      return { orderId: job.orderId, stage, progress };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await this.notify(result.orderId, { type: 'stage', stage: result.stage, progress: result.progress });
    return this.getJob(jobId);
  }

  async pause(actor: AuthUser, jobId: string, pause: boolean, noteValue?: unknown) {
    const job = await this.requireJob(jobId);
    if (job.status === ProductionStatus.COMPLETED) throw new ConflictException('La producción ya se completó.');
    if (pause && job.status === ProductionStatus.PAUSED) throw new ConflictException('La producción ya está pausada.');
    if (!pause && job.status !== ProductionStatus.PAUSED) throw new ConflictException('La producción no está pausada.');
    const status = pause ? ProductionStatus.PAUSED : ProductionStatus.ACTIVE;
    await this.prisma.productionJob.update({ where: { id: jobId }, data: { status, pausedAt: pause ? new Date() : null } });
    await this.prisma.auditLog.create({ data: { userId: actor.id, action: pause ? 'PRODUCTION_PAUSED' : 'PRODUCTION_RESUMED', entity: 'ProductionJob', entityId: jobId, metadata: { note: noteValue ? text(noteValue, 'Motivo', 500) : null } } });
    return this.getJob(jobId);
  }

  async addNote(actor: AuthUser, jobId: string, input: Record<string, unknown>) {
    const job = await this.requireJob(jobId);
    const visibility = String(input.visibility ?? 'INTERNAL') as NoteVisibility;
    if (!Object.values(NoteVisibility).includes(visibility)) throw new BadRequestException('Visibilidad de nota inválida.');
    const note = await this.prisma.productionNote.create({ data: {
      jobId, visibility, content: text(input.content, 'Nota', 2000), userId: actor.id,
    } });
    await this.core.audit(actor.id, 'PRODUCTION_NOTE_ADDED', 'ProductionNote', note.id, { jobId, visibility });
    if (visibility === NoteVisibility.PUBLIC) await this.notify(job.orderId, { type: 'public-update', message: note.content });
    return note;
  }

  async addIncident(actor: AuthUser, jobId: string, input: Record<string, unknown>) {
    await this.requireJob(jobId);
    const incident = await this.prisma.incident.create({ data: {
      jobId, title: text(input.title, 'Título', 160), description: text(input.description, 'Descripción', 2000), userId: actor.id,
    } });
    await this.core.audit(actor.id, 'INCIDENT_CREATED', 'Incident', incident.id, { jobId });
    return incident;
  }

  async resolveIncident(actor: AuthUser, id: string) {
    const incident = await this.prisma.incident.findUnique({ where: { id } });
    if (!incident) throw new NotFoundException('Incidencia no encontrada.');
    const updated = await this.prisma.incident.update({ where: { id }, data: { isOpen: false, resolvedAt: new Date() } });
    await this.core.audit(actor.id, 'INCIDENT_RESOLVED', 'Incident', id);
    return updated;
  }

  async addPhoto(actor: AuthUser, jobId: string, file: Express.Multer.File, caption?: string, isPublic = false) {
    if (!file) throw new BadRequestException('Selecciona una fotografía.');
    const extensionByMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
    const expectedExtension = extensionByMime[file.mimetype as keyof typeof extensionByMime];
    const filename = basename(file.filename ?? '');
    const filePath = resolve(file.destination || process.env.UPLOAD_DIR || 'uploads', filename);
    if (!expectedExtension || !new RegExp(`^[0-9a-f-]{36}\\.${expectedExtension}$`).test(filename)) {
      await unlink(filePath).catch(() => undefined);
      throw new BadRequestException('Usa una fotografía JPEG, PNG o WebP válida.');
    }
    let job: Awaited<ReturnType<ProductionService['requireJob']>>;
    let photo: Awaited<ReturnType<PrismaService['productionPhoto']['create']>>;
    try {
      job = await this.requireJob(jobId);
      const contents = await readFile(filePath);
      const isJpeg = expectedExtension === 'jpg' && contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff;
      const isPng = expectedExtension === 'png' && contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isWebp = expectedExtension === 'webp' && contents.length >= 12 && contents.toString('ascii', 0, 4) === 'RIFF' && contents.toString('ascii', 8, 12) === 'WEBP';
      if (!isJpeg && !isPng && !isWebp) throw new BadRequestException('El contenido del archivo no coincide con una imagen JPEG, PNG o WebP.');
      const safeCaption = caption ? text(caption, 'Descripción', 180) : null;
      photo = await this.prisma.productionPhoto.create({ data: {
        jobId, url: `/api/files/${filename}`, caption: safeCaption,
        public: isPublic, userId: actor.id,
      } });
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new BadRequestException('No se pudo leer la fotografía cargada.');
      throw error;
    }
    await this.core.audit(actor.id, 'PRODUCTION_PHOTO_ADDED', 'ProductionPhoto', photo.id, { jobId, public: isPublic });
    if (isPublic) await this.notify(job.orderId, { type: 'public-photo', caption: photo.caption });
    return photo;
  }

  async getPhotoFile(id: string) {
    const photo = await this.prisma.productionPhoto.findUnique({ where: { id } });
    if (!photo) throw new NotFoundException('Fotografía no encontrada.');
    return photo.url.split('/').at(-1)!;
  }

  async publicPhotoFile(token: string, id: string) {
    const photo = await this.prisma.productionPhoto.findFirst({
      where: { id, public: true, job: { order: { trackingToken: token } } },
    });
    if (!photo) throw new NotFoundException('Fotografía pública no encontrada.');
    return photo.url.split('/').at(-1)!;
  }

  private async notify(orderId: string, payload: Record<string, unknown>) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT ?? 'mailto:local@carpinteria.invalid';
    if (!publicKey || !privateKey) return;
    const webpush = await import('web-push');
    webpush.default.setVapidDetails(subject, publicKey, privateKey);
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { trackingToken: true } });
    const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:8080';
    const notification = { ...payload, url: order ? new URL(`/seguimiento/${order.trackingToken}`, baseUrl).toString() : baseUrl };
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { orderId, enabled: true } });
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webpush.default.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(notification));
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) await this.prisma.pushSubscription.update({ where: { id: subscription.id }, data: { enabled: false } });
      }
    }));
  }
}
