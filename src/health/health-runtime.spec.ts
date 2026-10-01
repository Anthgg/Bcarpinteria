import { PhotoStorageService } from '../storage/photo-storage.service';
import type { ObjectStore } from '../storage/photo-storage.service';
import { HealthService } from './health.service';
import type { PrismaService } from '../prisma.service';

const objects = (inspect: ObjectStore['inspect']): ObjectStore => ({
  upload: jest.fn(), download: jest.fn(), remove: jest.fn(), inspect,
});

describe('HealthService runtime report', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it('identifies the Supabase runtime and storage without exposing connection details', async () => {
    process.env.APP_ENV = 'SUPABASE';
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as unknown as PrismaService;
    const storage = new PhotoStorageService({ driver: 'supabase', objects: objects(jest.fn().mockResolvedValue({ exists: true, public: false })) });

    const report = await new HealthService(prisma, storage).check();

    expect(report.environment).toBe('SUPABASE');
    expect(report.database).toEqual({ provider: 'PostgreSQL (Supabase)', connected: true, message: 'PostgreSQL conectado' });
    expect(report.storage).toEqual({ driver: 'supabase', status: 'conectado' });
  });

  it('summarizes database failures without the driver message (which can contain the host)', async () => {
    const prisma = { $queryRaw: jest.fn().mockRejectedValue(new Error("Can't reach database server at `aws-0-x.pooler.supabase.com:6543`")) } as unknown as PrismaService;

    const report = await new HealthService(prisma).check();

    expect(report.database.connected).toBe(false);
    expect(report.database.message).toBe('PostgreSQL no disponible');
    expect(JSON.stringify(report)).not.toContain('pooler');
  });

  it('only reads the database (no SystemProbe writes)', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      systemProbe: { create: jest.fn(), upsert: jest.fn() },
      $executeRaw: jest.fn(),
    };
    await new HealthService(prisma as unknown as PrismaService).check();
    expect(prisma.systemProbe.create).not.toHaveBeenCalled();
    expect(prisma.systemProbe.upsert).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('PhotoStorageService.status', () => {
  it('reports local storage without touching any bucket', async () => {
    await expect(new PhotoStorageService({ driver: 'local' }).status()).resolves.toEqual({ driver: 'local', status: 'configurado' });
  });

  it('reads bucket metadata at most once per minute and flags unsafe buckets', async () => {
    const inspect = jest.fn().mockResolvedValue({ exists: true, public: true });
    const storage = new PhotoStorageService({ driver: 'supabase', objects: objects(inspect) });

    await expect(storage.status(1_000)).resolves.toEqual({ driver: 'supabase', status: 'bucket público' });
    await storage.status(30_000);
    expect(inspect).toHaveBeenCalledTimes(1);
    inspect.mockRejectedValue(new Error('network'));
    await expect(storage.status(62_000)).resolves.toEqual({ driver: 'supabase', status: 'no disponible' });
  });
});
