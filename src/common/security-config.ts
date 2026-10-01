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

export const REMOTE_ENVIRONMENTS = new Set(['SUPABASE', 'PRODUCTION']);

// Con APP_ENV=SUPABASE o PRODUCTION la API solo arranca contra el Supavisor Transaction Pooler (6543)
// configurado para Prisma. Evita levantar el runtime con la DIRECT_URL (5432, reservada a migraciones)
// o sin TLS. En PRODUCTION además exige fotos en Supabase y que DIRECT_URL no llegue al contenedor.
// Los mensajes nunca incluyen la URL, el host ni credenciales.
export function assertRuntimeDatabase(env: NodeJS.ProcessEnv = process.env): void {
  if (!REMOTE_ENVIRONMENTS.has(env.APP_ENV ?? '')) return;
  const label = `APP_ENV=${env.APP_ENV}`;
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error(`${label} requiere DATABASE_URL válida (Transaction Pooler).`);
  }
  const problems = [
    url.port !== '6543' && 'puerto 6543 (Transaction Pooler)',
    url.searchParams.get('pgbouncer') !== 'true' && 'pgbouncer=true',
    url.searchParams.get('sslmode') !== 'require' && 'sslmode=require',
    !url.searchParams.get('connection_limit') && 'connection_limit',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`${label}: DATABASE_URL debe usar ${problems.join(', ')}. DIRECT_URL (5432) es solo para migraciones.`);
  }
  if (env.APP_ENV === 'PRODUCTION') {
    if (env.STORAGE_DRIVER !== 'supabase') throw new Error('APP_ENV=PRODUCTION requiere STORAGE_DRIVER=supabase (Cloud Run no tiene disco persistente).');
    if (env.DIRECT_URL) throw new Error('APP_ENV=PRODUCTION: DIRECT_URL no debe llegar al runtime; las migraciones se ejecutan aparte.');
  }
}

// Saltos de proxy de confianza para req.ip (límite de intentos de login). Sin valor no se confía en
// X-Forwarded-For. En Cloud Run: Google Front End + nginx del mismo servicio = 2.
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return undefined;
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > 5) throw new Error('TRUST_PROXY_HOPS debe ser un entero entre 1 y 5.');
  return hops;
}
