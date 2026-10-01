// Prisma Migrate contra Supabase, deliberadamente y SIEMPRE por DIRECT_URL (Session Pooler 5432).
//
//   npm run db:supabase:status                          -> prisma migrate status (lectura)
//   SUPABASE_MIGRATE_CONFIRM=YES npm run db:supabase:deploy -> prisma migrate deploy
//
// Lee DIRECT_URL de .env.supabase (o del entorno) y la pasa como DATABASE_URL solo al proceso hijo.
// Rechaza el Transaction Pooler (6543 / pgbouncer=true): las migraciones no funcionan a través de él.
// Nunca imprime la cadena de conexión.
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const command = process.argv[2];
const fail = (message) => { console.error(message); process.exit(1); };
if (!['status', 'deploy'].includes(command)) fail('Uso: supabase-migrate.cjs <status|deploy>');
if (command === 'deploy' && process.env.SUPABASE_MIGRATE_CONFIRM !== 'YES') fail('ABORT: migrate deploy contra Supabase exige SUPABASE_MIGRATE_CONFIRM=YES.');

let directUrl = process.env.DIRECT_URL;
const file = join(__dirname, '..', '.env.supabase');
if (!directUrl && existsSync(file)) {
  const match = readFileSync(file, 'utf8').match(/^DIRECT_URL\s*=\s*"?([^"\r\n]*)"?/m);
  directUrl = match?.[1];
}
if (!directUrl) fail('Falta DIRECT_URL (en .env.supabase o en el entorno).');

let url;
try { url = new URL(directUrl); } catch { fail('DIRECT_URL no es una URL válida.'); }
if (url.port === '6543' || url.searchParams.get('pgbouncer') === 'true') fail('ABORT: DIRECT_URL apunta al Transaction Pooler; usa el Session Pooler (5432).');
if (url.searchParams.get('sslmode') !== 'require') fail('ABORT: DIRECT_URL debe incluir sslmode=require.');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['prisma', 'migrate', command], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, DATABASE_URL: directUrl },
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const redact = (text) => String(text ?? '')
  .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
  .replace(/"[^"]*\.pooler\.supabase\.com:\d+"/g, '"<supabase-pooler>:5432"')
  .replace(/[\w.-]+\.supabase\.(co|com)/g, '<supabase>');
process.stdout.write(redact(result.stdout));
process.stderr.write(redact(result.stderr));
process.exit(result.status ?? 1);
