import express from 'express';
import multer from 'multer';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHOTO_MAX_BYTES } from '../storage/photo-storage.service';
import { PHOTO_UPLOAD_OPTIONS } from './production.controller';

// Ejecuta la configuración real de multer del endpoint de fotos sobre HTTP.
describe('photo upload limits', () => {
  let server: Server;
  let base: string;
  let directory: string;
  const previousUploadDir = process.env.UPLOAD_DIR;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carpinteria-limits-'));
    process.env.UPLOAD_DIR = directory;
    const app = express();
    app.post('/photos', multer(PHOTO_UPLOAD_OPTIONS as multer.Options).single('photo'), (request, response) => {
      response.json({ size: request.file?.size });
    });
    app.use((error: { code?: string; message: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: error.code, message: error.message });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    process.env.UPLOAD_DIR = previousUploadDir;
    await rm(directory, { recursive: true, force: true });
  });

  const send = (bytes: number, type: string) => {
    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array(bytes)], { type }), 'foto');
    return fetch(`${base}/photos`, { method: 'POST', body: form });
  };

  it('accepts an image of exactly 8 MB', async () => {
    const response = await send(PHOTO_MAX_BYTES, 'image/jpeg');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ size: PHOTO_MAX_BYTES });
  });

  it('rejects files larger than 8 MB', async () => {
    const response = await send(PHOTO_MAX_BYTES + 1, 'image/png');
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 'LIMIT_FILE_SIZE' });
  });

  it('rejects non image MIME types before writing them', async () => {
    const before = await readdir(directory);
    const response = await send(10, 'image/svg+xml');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: 'Usa una imagen PNG, JPEG o WebP.' });
    expect(await readdir(directory)).toEqual(before);
  });
});
