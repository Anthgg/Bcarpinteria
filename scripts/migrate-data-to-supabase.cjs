// Migración única y controlada de datos: PostgreSQL local -> Supabase (A015.3).
//
//   SOURCE_DATABASE_URL  base origen (PostgreSQL local de Docker)
//   TARGET_DATABASE_URL  base destino (Supabase DIRECT_URL, Session Pooler 5432, sslmode=require)
//
//   node scripts/migrate-data-to-supabase.cjs --dry-run           -> solo comprobaciones y plan
//   MIGRATION_CONFIRM=YES node scripts/migrate-data-to-supabase.cjs -> copia en UNA transacción remota
//
// Reglas: el destino debe tener el esquema migrado y estar VACÍO (si no, aborta; nunca hace upsert),
// los IDs, timestamps, decimales y JSON se copian como texto de PostgreSQL (row_to_json ->
// json_populate_recordset) sin pasar por números de JavaScript, y antes del COMMIT se comparan
// conteos y huellas SHA-256 de cada tabla. No lee .env ni DATABASE_URL y nunca imprime URLs.
const { PrismaClient } = require('@prisma/client');

// Orden compatible con las foreign keys (se verifica contra el catálogo antes de copiar).
const TABLES = [
  'User', 'Customer', 'Product', 'InventoryItem', 'MaterialPiece', 'Order', 'OrderLine', 'Payment',
  'ProductionJob', 'JobComponent', 'RequiredPiece', 'PieceReservation', 'ItemReservation',
  'InventoryMovement', 'ProductionStageHistory', 'ProductionNote', 'Incident', 'ProductionPhoto',
  'CuttingPlan', 'AuditLog', 'AppSetting', 'NumberSequence',
];
// Se insertan en NULL y se completan en una segunda pasada (referencias a la misma tabla).
const SELF_REFERENCES = { MaterialPiece: ['originPieceId'] };
const EXCLUDED = {
  Session: 'sesiones y cookies del origen local',
  PushSubscription: 'endpoints Web Push del navegador/origen local; se vuelven a suscribir en el dominio final',
  SystemProbe: 'dato técnico del health check, no es negocio',
};
// Sequence -> tabla.columna y prefijo de los códigos que genera.
const SEQUENCES = { order: ['Order', 'PED'], piece: ['MaterialPiece', 'TAB'], offcut: ['MaterialPiece', 'RET'] };
const SENSITIVE_SETTING = /(pass|secret|token|private|api.?key|credential)/i;
const BATCH_SIZE = 250;

const dryRun = process.argv.includes('--dry-run');
const q = (name) => `"public"."${name.replace(/"/g, '""')}"`;
const col = (name) => `"${name.replace(/"/g, '""')}"`;
const fail = (message) => { const e = new Error(message); e.controlled = true; throw e; };
const sanitize = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').replace(/[\w.-]+@[\w.-]+:\d+/g, '<host>');
const log = (...parts) => console.log(...parts);
const fingerprintSql = (table) => `SELECT count(*)::int AS n, encode(sha256(convert_to(coalesce(string_agg(j, E'\\n' ORDER BY j), ''), 'UTF8')), 'hex') AS h
  FROM (SELECT row_to_json(t)::text AS j FROM ${q(table)} t) x`;

async function catalog(db) {
  const tables = (await db.$queryRawUnsafe(`SELECT table_name AS t FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => r.t);
  const columns = {};
  for (const r of await db.$queryRawUnsafe(`SELECT table_name AS t, column_name AS c, udt_name AS u
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`))
    (columns[r.t] ??= []).push(`${r.c}:${r.u}`);
  const fks = await db.$queryRawUnsafe(`SELECT c.conname AS name, src.relname AS "from", a.attname AS "column", dst.relname AS "to", da.attname AS "toColumn"
    FROM pg_constraint c JOIN pg_class src ON src.oid = c.conrelid JOIN pg_class dst ON dst.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute da ON da.attrelid = c.confrelid AND da.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) = 1 ORDER BY 1`);
  const migrations = await db.$queryRawUnsafe(`SELECT migration_name AS m, checksum AS c FROM "public"."_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
  return { tables, columns, fks, migrations };
}

async function counts(db, tables) {
  const out = {};
  for (const t of tables) out[t] = (await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${q(t)}`))[0].n;
  return out;
}

async function fingerprints(db, tables) {
  const out = {};
  for (const t of tables) out[t] = (await db.$queryRawUnsafe(fingerprintSql(t)))[0];
  return out;
}

async function preflight(source, target) {
  const problems = [];
  const [src, dst] = [await catalog(source), await catalog(target)];

  // 1. Mismo esquema y mismas migraciones en ambos lados.
  if (JSON.stringify(src.tables) !== JSON.stringify(dst.tables)) problems.push('Las tablas de public no coinciden entre origen y destino.');
  if (JSON.stringify(src.columns) !== JSON.stringify(dst.columns)) problems.push('Las columnas no coinciden entre origen y destino.');
  if (JSON.stringify(src.migrations) !== JSON.stringify(dst.migrations)) problems.push('Las migraciones Prisma aplicadas no coinciden.');

  // 2. Toda tabla de la app está clasificada (migrar o excluir).
  const known = new Set([...TABLES, ...Object.keys(EXCLUDED), '_prisma_migrations']);
  for (const t of src.tables) if (!known.has(t)) problems.push(`Tabla sin clasificar: ${t}.`);
  for (const t of [...TABLES, ...Object.keys(EXCLUDED)]) if (!src.tables.includes(t)) problems.push(`Falta la tabla ${t}.`);

  // 3. El orden respeta las foreign keys y nada migrado depende de tablas excluidas.
  for (const fk of src.fks) {
    if (!TABLES.includes(fk.from)) continue;
    if (fk.from === fk.to) {
      if (!(SELF_REFERENCES[fk.from] ?? []).includes(fk.column)) problems.push(`Auto-referencia no prevista: ${fk.from}.${fk.column}.`);
      continue;
    }
    if (!TABLES.includes(fk.to)) problems.push(`${fk.from}.${fk.column} apunta a la tabla excluida ${fk.to}.`);
    else if (TABLES.indexOf(fk.to) > TABLES.indexOf(fk.from)) problems.push(`Orden inválido: ${fk.from} se copiaría antes que ${fk.to}.`);
  }

  // 4. Destino vacío (tablas migrables y excluidas).
  const targetCounts = await counts(target, [...TABLES, ...Object.keys(EXCLUDED)]);
  for (const [t, n] of Object.entries(targetCounts)) if (n !== 0) problems.push(`El destino ya tiene ${n} filas en ${t}.`);

  // 5. Integridad del origen: referencias huérfanas, settings sensibles, secuencias.
  for (const fk of src.fks) {
    if (!TABLES.includes(fk.from) || !TABLES.includes(fk.to)) continue;
    const [{ n }] = await source.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${q(fk.from)} s
      WHERE s.${col(fk.column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${q(fk.to)} d WHERE d.${col(fk.toColumn)} = s.${col(fk.column)})`);
    if (n) problems.push(`${n} referencias huérfanas en ${fk.name}.`);
  }
  const settingKeys = (await source.$queryRawUnsafe(`SELECT key FROM "public"."AppSetting" ORDER BY key`)).map((r) => r.key);
  for (const key of settingKeys) if (SENSITIVE_SETTING.test(key)) problems.push(`AppSetting contiene una clave posiblemente sensible: ${key}.`);
  const sequences = {};
  for (const r of await source.$queryRawUnsafe(`SELECT name, value FROM "public"."NumberSequence" ORDER BY name`)) sequences[r.name] = r.value;
  const sequenceReport = [];
  for (const [name, [table, prefix]] of Object.entries(SEQUENCES)) {
    const [{ max }] = await source.$queryRawUnsafe(`SELECT coalesce(max(substring(code FROM '^${prefix}-(\\d+)$')::int), 0) AS max FROM ${q(table)}`);
    const value = sequences[name] ?? 0;
    sequenceReport.push(`${name}=${value} (máximo ${prefix}-${String(max).padStart(5, '0')})`);
    if (value < max) problems.push(`NumberSequence ${name}=${value} es menor que el código existente ${prefix}-${max}.`);
  }
  const [{ n: duplicatedReservations }] = await source.$queryRawUnsafe(`SELECT count(*)::int AS n FROM (SELECT "pieceId"
    FROM "public"."PieceReservation" WHERE status = 'RESERVED' GROUP BY 1 HAVING count(*) > 1) d`);
  if (duplicatedReservations) problems.push(`${duplicatedReservations} piezas con más de una reserva activa.`);

  return { problems, columns: src.columns, sourceCounts: await counts(source, [...TABLES, ...Object.keys(EXCLUDED)]), sequenceReport };
}

async function copyAll(source, target, columns) {
  // Instantánea consistente del origen (REPEATABLE READ, solo lectura).
  const data = await source.$transaction(async (s) => {
    await s.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const rows = {};
    const prints = {};
    for (const t of TABLES) {
      rows[t] = (await s.$queryRawUnsafe(`SELECT row_to_json(t)::text AS j FROM ${q(t)} t ORDER BY 1`)).map((r) => r.j);
      prints[t] = (await s.$queryRawUnsafe(fingerprintSql(t)))[0];
    }
    return { rows, prints };
  }, { timeout: 120_000 });

  const timings = [];
  await target.$transaction(async (tx) => {
    for (const t of TABLES) {
      const started = performance.now();
      const names = columns[t].map((c) => c.split(':')[0]);
      const selfRefs = SELF_REFERENCES[t] ?? [];
      const list = names.map(col).join(', ');
      const values = names.map((n) => (selfRefs.includes(n) ? 'NULL' : col(n))).join(', ');
      let inserted = 0;
      for (let i = 0; i < data.rows[t].length; i += BATCH_SIZE) {
        const batch = `[${data.rows[t].slice(i, i + BATCH_SIZE).join(',')}]`;
        inserted += await tx.$executeRawUnsafe(`INSERT INTO ${q(t)} (${list}) SELECT ${values} FROM json_populate_recordset(NULL::${q(t)}, $1::json)`, batch);
      }
      for (const ref of selfRefs) {
        for (let i = 0; i < data.rows[t].length; i += BATCH_SIZE) {
          const batch = `[${data.rows[t].slice(i, i + BATCH_SIZE).join(',')}]`;
          await tx.$executeRawUnsafe(`UPDATE ${q(t)} d SET ${col(ref)} = s.${col(ref)} FROM json_populate_recordset(NULL::${q(t)}, $1::json) s
            WHERE d."id" = s."id" AND s.${col(ref)} IS NOT NULL`, batch);
        }
      }
      if (inserted !== data.rows[t].length) fail(`${t}: se insertaron ${inserted} de ${data.rows[t].length} filas.`);
      timings.push({ table: t, rows: inserted, ms: Math.round(performance.now() - started) });
    }
    // Verificación ANTES del commit: cualquier diferencia revierte todo.
    const after = await fingerprints(tx, TABLES);
    for (const t of TABLES) {
      if (after[t].n !== data.prints[t].n || after[t].h !== data.prints[t].h) fail(`Huella distinta en ${t}; se revierte la transacción.`);
    }
    const excluded = await counts(tx, Object.keys(EXCLUDED));
    for (const [t, n] of Object.entries(excluded)) if (n !== 0) fail(`La tabla excluida ${t} tiene ${n} filas; se revierte.`);
  }, { timeout: 600_000, maxWait: 30_000 });
  return { timings, prints: data.prints };
}

async function main() {
  const { SOURCE_DATABASE_URL: sourceUrl, TARGET_DATABASE_URL: targetUrl } = process.env;
  if (!sourceUrl || !targetUrl) fail('Define SOURCE_DATABASE_URL y TARGET_DATABASE_URL.');
  if (sourceUrl === targetUrl) fail('Origen y destino son la misma URL.');
  if (!dryRun && process.env.MIGRATION_CONFIRM !== 'YES') fail('ABORT: falta MIGRATION_CONFIRM=YES (o usa --dry-run).');

  const source = new PrismaClient({ datasourceUrl: sourceUrl, log: [] });
  const target = new PrismaClient({ datasourceUrl: targetUrl, log: [] });
  try {
    await source.$queryRawUnsafe('SELECT 1'); log('SOURCE: connected');
    await target.$queryRawUnsafe('SELECT 1'); log('TARGET: connected');

    const { problems, columns, sourceCounts, sequenceReport } = await preflight(source, target);
    log(`\nTablas a migrar (${TABLES.length}):`);
    for (const t of TABLES) log(`  ${t.padEnd(24)} ${String(sourceCounts[t]).padStart(6)}`);
    log(`  ${'TOTAL'.padEnd(24)} ${String(TABLES.reduce((s, t) => s + sourceCounts[t], 0)).padStart(6)}`);
    log('Tablas excluidas:');
    for (const [t, why] of Object.entries(EXCLUDED)) log(`  ${t.padEnd(24)} ${String(sourceCounts[t]).padStart(6)}  (${why})`);
    log(`Secuencias: ${sequenceReport.join(', ')}`);
    log(`Problemas: ${problems.length}`);
    for (const p of problems) log(`  - ${p}`);
    if (problems.length) fail('ABORT: el preflight encontró problemas; no se copió nada.');
    if (dryRun) { log('\nDRY RUN OK: sin escrituras.'); return; }

    const started = new Date();
    log(`\nInicio: ${started.toISOString()}`);
    const { timings } = await copyAll(source, target, columns);
    const finished = new Date();
    for (const r of timings) log(`  copiado ${r.table.padEnd(24)} ${String(r.rows).padStart(6)} filas  ${r.ms} ms`);
    log(`Fin: ${finished.toISOString()}  duración ${((finished - started) / 1000).toFixed(1)} s  (COMMIT)`);

    // Verificación posterior con lecturas nuevas en ambos lados.
    const [a, b] = [await fingerprints(source, TABLES), await fingerprints(target, TABLES)];
    const excluded = await counts(target, Object.keys(EXCLUDED));
    log('\nValidación (tabla | origen | destino | huella):');
    let ok = true;
    for (const t of TABLES) {
      const match = a[t].n === b[t].n && a[t].h === b[t].h;
      ok &&= match;
      log(`  ${t.padEnd(24)} ${String(a[t].n).padStart(6)} ${String(b[t].n).padStart(6)}  ${match ? 'MATCH' : 'DIFERENTE'} ${b[t].h.slice(0, 12)}`);
    }
    for (const [t, n] of Object.entries(excluded)) log(`  ${t.padEnd(24)} ${String(sourceCounts[t]).padStart(6)} ${String(n).padStart(6)}  excluida`);
    if (!ok) fail('La verificación posterior encontró diferencias.');
    log('\nMIGRACIÓN OK');
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.controlled ? error.message : `ERROR ${error.code ?? ''} ${sanitize(error.message).split('\n').slice(-3).join(' ')}`);
  process.exit(1);
});
