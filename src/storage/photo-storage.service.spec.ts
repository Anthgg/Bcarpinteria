import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PhotoStorageService, SupabaseObjectStore, sendPhoto, storageDriverFromEnv } from './photo-storage.service';
import type { ObjectStore } from './photo-storage.service';

const objects = (): jest.Mocked<ObjectStore> => ({
  upload: jest.fn().mockResolvedValue(undefined),
  download: jest.fn().mockResolvedValue(Buffer.from('remote-bytes')),
  remove: jest.fn().mockResolvedValue(undefined),
});
const legacyUrl = '/api/files/550e8400-e29b-41d4-a716-446655440000.png';

describe('PhotoStorageService configuration', () => {
  it('defaults to local and accepts only local or supabase', () => {
    expect(storageDriverFromEnv(undefined)).toBe('local');
    expect(storageDriverFromEnv(' Supabase ')).toBe('supabase');
    expect(() => storageDriverFromEnv('s3')).toThrow('STORAGE_DRIVER debe ser "local" o "supabase".');
  });

  it('refuses the supabase driver without credentials and never echoes configured values', () => {
    const secret = 'sb_secret_should_never_be_logged';
    let message = '';
    try { SupabaseObjectStore.fromEnv({ SUPABASE_SECRET_KEY: secret, SUPABASE_STORAGE_BUCKET: 'production-photos' }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain('SUPABASE_URL');
    expect(message).not.toContain(secret);
  });

  it('builds stable private object paths and rejects unsafe identifiers', () => {
    const storage = new PhotoStorageService({ driver: 'local' });
    expect(storage.objectPath('job-1', 'photo-1', 'png')).toBe('production/job-1/photo-1.png');
    expect(() => storage.objectPath('../job', 'photo-1', 'png')).toThrow();
    expect(() => storage.objectPath('job-1', 'photo 1.png', 'png')).toThrow();
  });
});

describe('PhotoStorageService reads and writes', () => {
  it('keeps the local driver on the legacy file even when a storagePath exists', async () => {
    const store = objects();
    const storage = new PhotoStorageService({ driver: 'local', objects: store, uploadDir: '/data/uploads' });
    await expect(storage.persist('job-1', 'photo-1', 'png', Buffer.from('x'))).resolves.toBeNull();
    await expect(storage.open({ url: legacyUrl, storagePath: 'production/job-1/photo-1.png' })).resolves.toEqual({
      kind: 'local', filename: '550e8400-e29b-41d4-a716-446655440000.png', root: expect.stringContaining('uploads'),
    });
    expect(store.upload).not.toHaveBeenCalled();
    expect(store.download).not.toHaveBeenCalled();
  });

  it('uploads to the private bucket without overwrite semantics in supabase mode', async () => {
    const store = objects();
    const storage = new PhotoStorageService({ driver: 'supabase', objects: store });
    await expect(storage.persist('job-1', 'photo-1', 'webp', Buffer.from('bytes'))).resolves.toBe('production/job-1/photo-1.webp');
    expect(store.upload).toHaveBeenCalledWith('production/job-1/photo-1.webp', Buffer.from('bytes'), 'image/webp');
  });

  it('reads the object by storagePath and falls back to the legacy file while a photo is not migrated', async () => {
    const store = objects();
    const storage = new PhotoStorageService({ driver: 'supabase', objects: store });
    await expect(storage.open({ url: legacyUrl, storagePath: 'production/job-1/photo-1.png' })).resolves.toEqual({
      kind: 'object', body: Buffer.from('remote-bytes'), contentType: 'image/png',
    });
    await expect(storage.open({ url: legacyUrl, storagePath: null })).resolves.toMatchObject({ kind: 'local' });
    expect(store.download).toHaveBeenCalledTimes(1);
  });

  it('propagates storage failures and rejects unknown legacy file names', async () => {
    const store = objects();
    store.download.mockRejectedValue(new NotFoundException('Fotografía no encontrada.'));
    const storage = new PhotoStorageService({ driver: 'supabase', objects: store });
    await expect(storage.open({ url: legacyUrl, storagePath: 'production/job-1/missing.png' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(storage.open({ url: '/api/files/../../etc/passwd', storagePath: null })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes orphaned objects only in supabase mode and tolerates removal errors', async () => {
    const store = objects();
    store.remove.mockRejectedValue(new Error('network'));
    await new PhotoStorageService({ driver: 'supabase', objects: store }).discard('production/job-1/photo-1.png');
    await new PhotoStorageService({ driver: 'local', objects: store }).discard('production/job-1/photo-1.png');
    expect(store.remove).toHaveBeenCalledTimes(1);
  });
});

describe('sendPhoto', () => {
  const response = () => {
    const res = { setHeader: jest.fn(), type: jest.fn(), send: jest.fn(), sendFile: jest.fn(), status: jest.fn(), end: jest.fn(), headersSent: false };
    res.status.mockReturnValue(res);
    return res;
  };

  it('streams bucket objects through the backend with an explicit image type', () => {
    const res = response();
    sendPhoto(res as unknown as Response, { kind: 'object', body: Buffer.from('img'), contentType: 'image/jpeg' }, 'private, no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.type).toHaveBeenCalledWith('image/jpeg');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('img'));
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  it('serves local files from the upload directory and answers 404 when the file is missing', () => {
    const res = response();
    sendPhoto(res as unknown as Response, { kind: 'local', filename: 'a.png', root: '/data/uploads' }, 'private, max-age=300');
    expect(res.sendFile).toHaveBeenCalledWith('a.png', { root: '/data/uploads' }, expect.any(Function));
    res.sendFile.mock.calls[0][2](new Error('ENOENT'));
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
