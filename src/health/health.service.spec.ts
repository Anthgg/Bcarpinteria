import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';
import { PrismaService } from '../prisma.service';

describe('HealthService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function makeService(connected: boolean): HealthService {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(connected ? [{ '?column?': 1 }] : undefined),
    } as unknown as PrismaService;

    if (!connected) {
      (prisma.$queryRaw as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );
    }

    return new HealthService(prisma);
  }

  it('reporta API OK con PostgreSQL conectado y entorno LOCAL', async () => {
    process.env.APP_ENV = 'LOCAL';
    process.env.BD_PATH = __filename;

    const report = await makeService(true).check();

    expect(report.status).toBe('API OK');
    expect(report.environment).toBe('LOCAL');
    expect(report.database.connected).toBe(true);
    expect(report.database.message).toBe('PostgreSQL conectado');
    expect(report.excel.file).toBe('inventario g.xlsx');
    expect(report.excel.exists).toBe(true);
    expect(report.excel.readOnly).toBe(true);
  });

  it('detecta cuando el archivo Excel no existe', async () => {
    process.env.APP_ENV = 'LOCAL';
    process.env.BD_PATH = '/ruta/que/no/existe/inventario g.xlsx';

    const report = await makeService(true).check();

    expect(report.excel.exists).toBe(false);
    expect(report.status).toBe('API OK');
  });

  it('resuelve la ruta por defecto del Excel cuando no hay BD_PATH', async () => {
    delete process.env.BD_PATH;

    const service = makeService(true);

    expect(service.bdPath.endsWith('inventario g.xlsx')).toBe(true);
  });
});

describe('HealthController', () => {
  it('lanza 503 cuando PostgreSQL no esta conectado', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaService;

    const { HealthController } = await import('./health.controller');
    const controller = new HealthController(new HealthService(prisma));

    await expect(controller.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
