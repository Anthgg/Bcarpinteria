import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const [activeOrders, readyOrders, stages, openIncidents, items, pieces, movements, monthOrders] = await Promise.all([
      this.prisma.order.count({ where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] } } }),
      this.prisma.order.count({ where: { status: 'READY' } }),
      this.prisma.productionJob.groupBy({ by: ['stage'], _count: { _all: true }, where: { status: { not: 'COMPLETED' } } }),
      this.prisma.incident.count({ where: { isOpen: true } }),
      this.prisma.inventoryItem.findMany({ where: { active: true, controlsStock: true }, select: { id: true, name: true, type: true, unit: true, stock: true } }),
      this.prisma.materialPiece.groupBy({ by: ['materialId'], where: { state: 'AVAILABLE' }, _count: { _all: true } }),
      this.prisma.inventoryMovement.findMany({ take: 12, orderBy: { createdAt: 'desc' }, include: { item: { select: { name: true, unit: true } }, piece: { select: { code: true, material: { select: { name: true } } } } } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: startOfMonth }, status: { not: 'CANCELLED' } }, _count: { _all: true }, _sum: { totalCents: true } }),
    ]);
    const threshold = Number((await this.prisma.appSetting.findUnique({ where: { key: 'low_stock_threshold' } }))?.value ?? 5);
    const availablePieces = new Map(pieces.map((row) => [row.materialId, row._count._all]));
    const lowStock = items.map((item) => ({ ...item, stock: Number(item.stock), availablePieces: availablePieces.get(item.id) ?? 0 }))
      .filter((item) => item.stock + item.availablePieces <= threshold)
      .sort((a, b) => (a.stock + a.availablePieces) - (b.stock + b.availablePieces));
    return {
      activeOrders,
      readyOrders,
      productionByStage: stages.map((row) => ({ stage: row.stage, count: row._count._all })),
      openIncidents,
      lowStock,
      recentMovements: movements.map((row) => ({
        id: row.id, action: row.action, quantity: row.quantity === null ? null : Number(row.quantity), note: row.note, createdAt: row.createdAt,
        itemName: row.item?.name ?? row.piece?.material.name ?? 'Pieza física', itemCode: row.piece?.code ?? null,
      })),
      period: { startsAt: startOfMonth.toISOString(), orders: monthOrders._count._all, orderTotalCents: monthOrders._sum.totalCents ?? 0 },
    };
  }

  auditLog() {
    return this.prisma.auditLog.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
  }
}
