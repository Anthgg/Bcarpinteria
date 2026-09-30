import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export type DashboardPeriod = '7d' | '30d' | 'month';

const limaCalendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
});

function limaDateKey(date: Date): string {
  const parts = Object.fromEntries(limaCalendar.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDateKey(dateKey: string, offset: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
}

function limaStartOfDay(dateKey: string): Date {
  return new Date(`${dateKey}T05:00:00.000Z`);
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(period: DashboardPeriod = 'month') {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const today = limaDateKey(new Date());
    const firstDate = period === '7d' ? shiftDateKey(today, -6) : period === '30d' ? shiftDateKey(today, -29) : `${today.slice(0, 7)}-01`;
    const endDate = shiftDateKey(today, 1);
    const [activeOrders, readyOrders, stages, openIncidents, items, pieces, movements, monthOrders, rangeOrders] = await Promise.all([
      this.prisma.order.count({ where: { status: { in: ['CONFIRMED', 'IN_PRODUCTION'] } } }),
      this.prisma.order.count({ where: { status: 'READY' } }),
      this.prisma.productionJob.groupBy({ by: ['stage'], _count: { _all: true }, where: { status: { not: 'COMPLETED' } } }),
      this.prisma.incident.count({ where: { isOpen: true } }),
      this.prisma.inventoryItem.findMany({ where: { active: true, controlsStock: true }, select: { id: true, name: true, type: true, unit: true, stock: true } }),
      this.prisma.materialPiece.groupBy({ by: ['materialId'], where: { state: 'AVAILABLE' }, _count: { _all: true } }),
      this.prisma.inventoryMovement.findMany({ take: 12, orderBy: { createdAt: 'desc' }, include: { item: { select: { name: true, unit: true } }, piece: { select: { code: true, material: { select: { name: true } } } } } }),
      this.prisma.order.aggregate({ where: { createdAt: { gte: startOfMonth }, status: { not: 'CANCELLED' } }, _count: { _all: true }, _sum: { totalCents: true } }),
      this.prisma.order.findMany({
        where: { createdAt: { gte: limaStartOfDay(firstDate), lt: limaStartOfDay(endDate) }, status: { not: 'CANCELLED' } },
        select: { createdAt: true, totalCents: true },
      }),
    ]);
    const threshold = Number((await this.prisma.appSetting.findUnique({ where: { key: 'low_stock_threshold' } }))?.value ?? 5);
    const availablePieces = new Map(pieces.map((row) => [row.materialId, row._count._all]));
    const lowStock = items.map((item) => ({ ...item, stock: Number(item.stock), availablePieces: availablePieces.get(item.id) ?? 0 }))
      .filter((item) => item.stock + item.availablePieces <= threshold)
      .sort((a, b) => (a.stock + a.availablePieces) - (b.stock + b.availablePieces));
    const ordersByDate = new Map<string, { date: string; orderCount: number; totalCents: number }>();
    for (let date = firstDate; date < endDate; date = shiftDateKey(date, 1)) {
      ordersByDate.set(date, { date, orderCount: 0, totalCents: 0 });
    }
    for (const order of rangeOrders) {
      const day = ordersByDate.get(limaDateKey(order.createdAt));
      if (!day) continue;
      day.orderCount += 1;
      day.totalCents += order.totalCents;
    }
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
      ordersTrend: { period, startsAt: limaStartOfDay(firstDate).toISOString(), endsAt: limaStartOfDay(endDate).toISOString(), points: [...ordersByDate.values()] },
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
