import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { SupabaseObjectStore } from './photo-storage.service';

// Prueba real contra el bucket privado. Solo corre con SUPABASE_STORAGE_IT=1 y las variables de Supabase;
// usa qa/… y elimina únicamente el objeto que crea. Nunca toca production/….
const enabled = process.env.SUPABASE_STORAGE_IT === '1';
const describeReal = enabled ? describe : describe.skip;
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

describeReal('SupabaseObjectStore against the private bucket (qa/)', () => {
  const path = `qa/a016-${randomUUID()}.png`;
  const body = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`qa ${new Date().toISOString()}`)]);
  let store: SupabaseObjectStore;

  beforeAll(() => { store = SupabaseObjectStore.fromEnv(); });
  afterAll(async () => { await store.remove(path).catch(() => undefined); });

  it('uploads, refuses overwrites and returns identical bytes', async () => {
    await store.upload(path, body, 'image/png');
    await expect(store.upload(path, Buffer.from('other'), 'image/png')).rejects.toBeInstanceOf(ConflictException);
    expect(sha(await store.download(path))).toBe(sha(body));
  });

  it('is not reachable through public or unauthenticated URLs', async () => {
    const base = `${process.env.SUPABASE_URL}/storage/v1/object`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    expect((await fetch(`${base}/public/${bucket}/${path}`)).ok).toBe(false);
    expect((await fetch(`${base}/${bucket}/${path}`)).ok).toBe(false);
  });

  it('enforces the bucket MIME allow-list', async () => {
    await expect(store.upload(`qa/a016-${randomUUID()}.txt`, Buffer.from('texto'), 'text/plain')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('removes only the QA object', async () => {
    await store.remove(path);
    await expect(store.download(path)).rejects.toBeInstanceOf(NotFoundException);
  });
});
