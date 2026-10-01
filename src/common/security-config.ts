const DEFAULT_CORS_ORIGINS = [
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];

export function corsOriginsFromEnv(): Set<string> {
  return new Set((process.env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean));
}

// Con APP_ENV=SUPABASE la API solo arranca contra el Supavisor Transaction Pooler (6543) configurado para
// Prisma. Evita levantar el runtime con la DIRECT_URL (5432, reservada a migraciones) o sin TLS.
// Los mensajes nunca incluyen la URL, el host ni credenciales.
export function assertRuntimeDatabase(env: NodeJS.ProcessEnv = process.env): void {
  if (env.APP_ENV !== 'SUPABASE') return;
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error('APP_ENV=SUPABASE requiere DATABASE_URL válida (Transaction Pooler).');
  }
  const problems = [
    url.port !== '6543' && 'puerto 6543 (Transaction Pooler)',
    url.searchParams.get('pgbouncer') !== 'true' && 'pgbouncer=true',
    url.searchParams.get('sslmode') !== 'require' && 'sslmode=require',
    !url.searchParams.get('connection_limit') && 'connection_limit',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`APP_ENV=SUPABASE: DATABASE_URL debe usar ${problems.join(', ')}. DIRECT_URL (5432) es solo para migraciones.`);
  }
}
