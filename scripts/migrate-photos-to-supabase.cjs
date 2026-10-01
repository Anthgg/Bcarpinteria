// Migración controlada de las fotografías existentes: volumen local (UPLOAD_DIR) -> Supabase Storage (A016).
//
//   SOURCE_DATABASE_URL       PostgreSQL local (también recibe storagePath, para mantener paridad)
//   TARGET_DATABASE_URL       Supabase DIRECT_URL (Session Pooler 5432)
//   SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET, UPLOAD_DIR
//
//   node scripts/migrate-photos-to-supabase.cjs --dry-run [--json]      -> inventario y plan, sin escrituras
//   PHOTO_MIGRATION_CONFIRM=YES node scripts/migrate-photos-to-supabase.cjs
//
// Por cada foto: leer archivo -> SHA-256 y tipo real -> subir SIN sobrescribir -> descargar y comparar
// bytes -> recién entonces guardar storagePath (destino y origen). Los archivos locales nunca se borran
// y `url` se conserva. El bucket se crea PRIVADO (o se exige que lo sea). No imprime URLs ni claves.
const { createHash } = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { createClient } = require('@supabase/supabase-js');

const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');
const MAX_BYTES = 8 * 1024 * 1024;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const BUCKET_OPTIONS = { public: false, allowedMimeTypes: Object.values(MIME), fileSizeLimit: MAX_BYTES };
const LEGACY_URL = /^\/api\/files\/([0-9a-f-]{36})\.(jpg|png|webp)$/;
const log = (...parts) => { if (!json) console.log(...parts); };
const fail = (message) => { const error = new Error(message); error.controlled = true; throw error; };
const sha256 = (body) => createHash('sha256').update(body).digest('hex');
const sniff = (body) => {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpg';
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
};
const isStatus = (error, code) => error && (error.status === code || error.statusCode === String(code)
  || (code === 409 && /already exists/i.test(error.message ?? '')) || (code === 404 && /not found/i.test(error.message ?? '')));

async function photosOf(db) {
  const [{ present }] = await db.$queryRawUnsafe(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ProductionPhoto' AND column_name = 'storagePath') AS present`);
  if (!present) fail('ProductionPhoto.storagePath no existe: aplica antes la migración 0004_photo_storage.');
  return db.$queryRawUnsafe(`SELECT id, "jobId", url, public, "storagePath" FROM "public"."ProductionPhoto" ORDER BY "createdAt", id`);
}

async function download(storage, path) {
  const { data, error } = await storage.download(path);
  if (error || !data) return isStatus(error, 404) || isStatus(error, 400) ? null : fail(`No se pudo descargar ${path}.`);
  return Buffer.from(await data.arrayBuffer());
}

async function main() {
  const env = process.env;
  for (const name of ['SOURCE_DATABASE_URL', 'TARGET_DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_STORAGE_BUCKET']) {
    if (!env[name]) fail(`Define ${name}.`);
  }
  if (env.SOURCE_DATABASE_URL === env.TARGET_DATABASE_URL) fail('Origen y destino son la misma base.');
  if (!dryRun && env.PHOTO_MIGRATION_CONFIRM !== 'YES') fail('ABORT: falta PHOTO_MIGRATION_CONFIRM=YES (o usa --dry-run).');
  const uploadDir = resolve(env.UPLOAD_DIR ?? 'uploads');
  const bucketName = env.SUPABASE_STORAGE_BUCKET;

  const source = new PrismaClient({ datasourceUrl: env.SOURCE_DATABASE_URL, log: [] });
  const target = new PrismaClient({ datasourceUrl: env.TARGET_DATABASE_URL, log: [] });
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    await source.$queryRawUnsafe('SELECT 1'); log('SOURCE: connected');
    await target.$queryRawUnsafe('SELECT 1'); log('TARGET: connected');

    // 1. Inventario: misma metadata en ambas bases y un archivo válido por registro.
    const [local, remote] = [await photosOf(source), await photosOf(target)];
    const problems = [];
    if (local.length !== remote.length) problems.push(`Registros distintos: local ${local.length}, Supabase ${remote.length}.`);
    const inventory = [];
    for (const photo of remote) {
      const twin = local.find((row) => row.id === photo.id);
      if (!twin || twin.url !== photo.url || twin.jobId !== photo.jobId) { problems.push(`La foto ${photo.id} no coincide entre bases.`); continue; }
      const match = LEGACY_URL.exec(photo.url);
      if (!match) { problems.push(`URL no reconocida en ${photo.id}.`); continue; }
      const file = join(uploadDir, `${match[1]}.${match[2]}`);
      const info = await stat(file).catch(() => null);
      if (!info) { problems.push(`Falta el archivo de ${photo.id}.`); continue; }
      const body = await readFile(file);
      const kind = sniff(body);
      const destination = `production/${photo.jobId}/${photo.id}.${match[2]}`;
      if (kind !== match[2]) problems.push(`El contenido de ${photo.id} no es ${match[2]}.`);
      if (info.size > MAX_BYTES) problems.push(`${photo.id} supera 8 MB.`);
      for (const row of [photo, twin]) if (row.storagePath && row.storagePath !== destination) problems.push(`${photo.id} ya apunta a otro objeto.`);
      inventory.push({
        id: photo.id, jobId: photo.jobId, url: photo.url, public: photo.public, file: `${match[1]}.${match[2]}`,
        bytes: info.size, mime: MIME[match[2]], detected: kind ? MIME[kind] : null, sha256: sha256(body), destination,
        storagePath: { supabase: photo.storagePath, local: twin.storagePath },
      });
    }

    // 2. Bucket privado con tipos y tamaño restringidos.
    const { data: bucket } = await supabase.storage.getBucket(bucketName);
    if (bucket) {
      const types = [...(bucket.allowed_mime_types ?? [])].sort().join(',');
      if (bucket.public) problems.push(`El bucket ${bucketName} es público.`);
      if (types !== [...BUCKET_OPTIONS.allowedMimeTypes].sort().join(',')) problems.push(`El bucket ${bucketName} admite otros tipos: ${types || 'cualquiera'}.`);
      if (Number(bucket.file_size_limit) !== MAX_BYTES) problems.push(`El bucket ${bucketName} tiene límite ${bucket.file_size_limit ?? 'ninguno'}.`);
    }

    if (json) { console.log(JSON.stringify({ bucket: bucket ? { name: bucket.name, public: bucket.public, allowed: bucket.allowed_mime_types, limit: bucket.file_size_limit } : null, photos: inventory, problems }, null, 2)); }
    log(`\nBucket ${bucketName}: ${bucket ? `existe (public=${bucket.public}, límite=${bucket.file_size_limit}, tipos=${(bucket.allowed_mime_types ?? []).join(',')})` : 'no existe; se creará privado'}`);
    log(`Fotos: ${remote.length} registros, ${inventory.length} archivos`);
    for (const row of inventory) {
      log(`  ${row.id.slice(0, 8)}… ${String(row.bytes).padStart(7)} B  ${row.mime.padEnd(10)} public=${String(row.public).padEnd(5)} sha=${row.sha256.slice(0, 12)}…  -> ${row.destination}${row.storagePath.supabase ? '  (ya migrada)' : ''}`);
    }
    log(`Problemas: ${problems.length}`);
    for (const problem of problems) log(`  - ${problem}`);
    if (problems.length || inventory.length !== remote.length) fail('ABORT: el inventario tiene problemas; no se subió nada.');
    if (dryRun) { log('\nDRY RUN OK: sin escrituras.'); return; }

    // 3. Bucket.
    if (!bucket) {
      const { error } = await supabase.storage.createBucket(bucketName, BUCKET_OPTIONS);
      if (error) fail(`No se pudo crear el bucket ${bucketName}.`);
      log(`Bucket ${bucketName} creado (privado, ${BUCKET_OPTIONS.allowedMimeTypes.join(', ')}, 8 MB).`);
    }
    const storage = supabase.storage.from(bucketName);

    // 4. Foto por foto: subir -> verificar -> recién entonces storagePath.
    let migrated = 0;
    for (const row of inventory) {
      const body = await readFile(join(uploadDir, row.file));
      if (sha256(body) !== row.sha256) fail(`El archivo de ${row.id} cambió durante la migración.`);
      const { error } = await storage.upload(row.destination, body, { contentType: row.mime, upsert: false, cacheControl: '3600' });
      if (error && !isStatus(error, 409)) fail(`Falló la subida de ${row.id}; ${migrated} fotos completas antes del error.`);
      const remoteBody = await download(storage, row.destination);
      if (!remoteBody || remoteBody.length !== row.bytes || sha256(remoteBody) !== row.sha256) {
        fail(`${row.id}: el objeto ${error ? 'existente' : 'subido'} no coincide byte a byte; no se actualiza la base.`);
      }
      for (const [name, db] of [['Supabase', target], ['local', source]]) {
        const updated = await db.$executeRawUnsafe(`UPDATE "public"."ProductionPhoto" SET "storagePath" = $1
          WHERE id = $2 AND ("storagePath" IS NULL OR "storagePath" = $1)`, row.destination, row.id);
        if (updated !== 1) fail(`${row.id}: no se pudo registrar storagePath en ${name}.`);
      }
      migrated += 1;
      log(`  OK ${row.id.slice(0, 8)}… ${error ? 'ya existía (idéntico)' : 'subida'}  ${row.bytes} B  sha=${row.sha256.slice(0, 12)}…`);
    }

    // 5. Verificación final.
    const after = await photosOf(target);
    const linked = after.filter((photo) => photo.storagePath).length;
    log(`\nMigradas: ${migrated}/${inventory.length}; storagePath en Supabase: ${linked}/${after.length}`);
    if (linked !== after.length) fail('Quedaron fotos sin storagePath.');
    log('MIGRACIÓN DE FOTOS OK');
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((error) => {
  console.error(error.controlled ? error.message : `ERROR ${String(error.message).replace(/postgres(ql)?:\/\/\S+/gi, '<url>').replace(/sb_secret_\S+/g, '<secret>').split('\n').slice(-2).join(' ')}`);
  process.exit(1);
});
