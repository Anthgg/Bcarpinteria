import { BadRequestException } from '@nestjs/common';
import { CoreService } from '../core/core.service';
import { HealthService } from '../health/health.service';
import type { PrismaService } from '../prisma.service';
import { assertRuntimeDatabase, trustProxyHops } from './security-config';

const pooler = 'postgresql://user.ref:secret-password@pooler.example.test:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require';
const production = { APP_ENV: 'PRODUCTION', DATABASE_URL: pooler, STORAGE_DRIVER: 'supabase' };

describe('PRODUCTION runtime guard', () => {
  it('accepts the Cloud Run configuration: pooler 6543, Supabase storage and no DIRECT_URL', () => {
    expect(() => assertRuntimeDatabase(production)).not.toThrow();
  });

  it('applies the same pooler rules as SUPABASE', () => {
    expect(() => assertRuntimeDatabase({ ...production, DATABASE_URL: pooler.replace(':6543/', ':5432/') })).toThrow('APP_ENV=PRODUCTION: DATABASE_URL debe usar puerto 6543');
  });

  it('refuses local photo storage in production', () => {
    expect(() => assertRuntimeDatabase({ ...production, STORAGE_DRIVER: 'local' })).toThrow('STORAGE_DRIVER=supabase');
  });

  it('refuses a DIRECT_URL in the runtime container without echoing it', () => {
    let message = '';
    try { assertRuntimeDatabase({ ...production, DIRECT_URL: pooler.replace(':6543/', ':5432/') }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('DIRECT_URL no debe llegar al runtime');
    expect(message).not.toContain('secret-password');
  });
});

describe('trustProxyHops', () => {
  it('does not trust forwarded headers unless configured', () => {
    expect(trustProxyHops({})).toBeUndefined();
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'true', '9'])('rejects %s', (value) => {
    expect(() => trustProxyHops({ TRUST_PROXY_HOPS: value })).toThrow('TRUST_PROXY_HOPS');
  });
});

describe('production environment behaviour', () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it('reports Supabase as the database provider for PRODUCTION', () => {
    process.env.APP_ENV = 'PRODUCTION';
    expect(new HealthService({} as PrismaService).databaseProvider).toBe('PostgreSQL (Supabase)');
  });

  it('disables the Excel import in PRODUCTION without touching the file system or database', async () => {
    process.env.APP_ENV = 'PRODUCTION';
    process.env.BD_PATH = '/no/existe/inventario g.xlsx';
    const prisma = { $transaction: jest.fn(), inventoryItem: { findMany: jest.fn() } };
    const service = new CoreService(prisma as never);
    await expect(service.previewImport()).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.previewImport()).rejects.toThrow('no está disponible en producción');
    await expect(service.importWorkbook({ id: 'u', email: 'a@b.c', name: 'A', role: 'ADMIN' } as never)).rejects.toThrow('no está disponible en producción');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inventoryItem.findMany).not.toHaveBeenCalled();
  });
});
