import { assertRuntimeDatabase } from './security-config';

const pooler = 'postgresql://user.ref:secret-password@pooler.example.test:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require';

describe('assertRuntimeDatabase', () => {
  it('does not constrain the local runtime', () => {
    expect(() => assertRuntimeDatabase({ APP_ENV: 'LOCAL', DATABASE_URL: 'postgresql://carpinteria:x@postgres:5432/carpinteria' })).not.toThrow();
    expect(() => assertRuntimeDatabase({})).not.toThrow();
  });

  it('accepts the Supabase transaction pooler configured for Prisma', () => {
    expect(() => assertRuntimeDatabase({ APP_ENV: 'SUPABASE', DATABASE_URL: pooler })).not.toThrow();
  });

  it.each([
    ['the session pooler / DIRECT_URL', pooler.replace(':6543/', ':5432/'), 'puerto 6543'],
    ['missing pgbouncer', pooler.replace('pgbouncer=true&', ''), 'pgbouncer=true'],
    ['missing TLS', pooler.replace('&sslmode=require', ''), 'sslmode=require'],
    ['missing connection_limit', pooler.replace('connection_limit=1&', ''), 'connection_limit'],
  ])('refuses %s without echoing the connection string', (_label, url, expected) => {
    let message = '';
    try { assertRuntimeDatabase({ APP_ENV: 'SUPABASE', DATABASE_URL: url }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(expected);
    expect(message).not.toContain('secret-password');
    expect(message).not.toContain('pooler.example.test');
  });

  it('refuses an empty or invalid DATABASE_URL in Supabase mode', () => {
    expect(() => assertRuntimeDatabase({ APP_ENV: 'SUPABASE' })).toThrow('DATABASE_URL válida');
  });
});
