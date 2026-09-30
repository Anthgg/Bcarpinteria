import { PrismaService } from '../prisma.service';
import { DashboardService } from './dashboard.service';

describe('DashboardService analytics', () => {
  function makeService() {
    const prisma = {
      order: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { totalCents: null } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      productionJob: { groupBy: jest.fn().mockResolvedValue([]) },
      incident: { count: jest.fn().mockResolvedValue(0) },
      inventoryItem: { findMany: jest.fn().mockResolvedValue([]) },
      materialPiece: { groupBy: jest.fn().mockResolvedValue([]) },
      inventoryMovement: { findMany: jest.fn().mockResolvedValue([]) },
      appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;

    return { service: new DashboardService(prisma), prisma };
  }

  it.each([
    ['7d', 7],
    ['30d', 30],
  ] as const)('returns the requested calendar window for %s', async (period, expectedDays) => {
    const { service, prisma } = makeService();
    const createdAt = new Date();
    const orderFindMany = (prisma.order.findMany as jest.Mock);
    orderFindMany.mockResolvedValue([{ createdAt, totalCents: 12_345 }]);

    const summary = await service.summary(period);

    expect(summary.ordersTrend.period).toBe(period);
    expect(summary.ordersTrend.points).toHaveLength(expectedDays);
    expect(summary.ordersTrend.points.reduce((sum, point) => sum + point.orderCount, 0)).toBe(1);
    expect(summary.ordersTrend.points.reduce((sum, point) => sum + point.totalCents, 0)).toBe(12_345);
    expect(orderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: 'CANCELLED' }, createdAt: { gte: expect.any(Date), lt: expect.any(Date) } }),
      select: { createdAt: true, totalCents: true },
    }));
  });

  it('preserves the existing monthly KPIs and fills every day of the current Lima month', async () => {
    const { service, prisma } = makeService();
    (prisma.order.aggregate as jest.Mock).mockResolvedValue({ _count: { _all: 3 }, _sum: { totalCents: 89_000 } });
    const summary = await service.summary('month');
    const limaParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map(({ type, value }) => [type, value]));

    expect(summary.period.orders).toBe(3);
    expect(summary.period.orderTotalCents).toBe(89_000);
    expect(summary.ordersTrend.points).toHaveLength(Number(limaParts.day));
    expect(summary.ordersTrend.points[0].date).toBe(`${limaParts.year}-${limaParts.month}-01`);
  });
});
