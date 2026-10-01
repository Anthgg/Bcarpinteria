import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Response } from 'express';
import { resolve } from 'node:path';

// Dónde viven los bytes de las fotografías de producción. La base de datos guarda una referencia
// estable (`url` del backend y, con Supabase, `storagePath`); nunca una URL firmada ni pública.
//   local    -> archivos en UPLOAD_DIR (volumen carpinteria_uploads), servidos por /api/files/…
//   supabase -> objetos del bucket PRIVADO SUPABASE_STORAGE_BUCKET bajo production/{jobId}/{photoId}.{ext}
// En ambos casos el navegador pide la imagen al backend, que autoriza antes de leer el storage.
export type StorageDriver = 'local' | 'supabase';
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
export type PhotoExtension = keyof typeof PHOTO_CONTENT_TYPES;
export const PHOTO_STORAGE_OPTIONS = 'PHOTO_STORAGE_OPTIONS';
const LOCAL_FILENAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const SAFE_SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

export type PhotoReference = { url: string; storagePath: string | null };
export type PhotoContent =
  | { kind: 'local'; filename: string; root: string }
  | { kind: 'object'; body: Buffer; contentType: string };

export interface ObjectStore {
  upload(path: string, body: Buffer, contentType: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
}

export type PhotoStorageOptions = { driver?: StorageDriver; objects?: ObjectStore; uploadDir?: string };

const isStatus = (error: unknown, code: number) => {
  const { status, statusCode, message } = (error ?? {}) as { status?: number; statusCode?: string; message?: string };
  return status === code || statusCode === String(code) || (code === 409 && /already exists/i.test(message ?? '')) || (code === 404 && /not found/i.test(message ?? ''));
};

// Cliente de Supabase Storage solo para el backend (secret key). Los errores nunca incluyen la clave ni la URL.
export class SupabaseObjectStore implements ObjectStore {
  private constructor(private readonly storage: SupabaseClient['storage'], private readonly bucket: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env) {
    const { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, SUPABASE_STORAGE_BUCKET: bucket } = env;
    if (!url || !key || !bucket) {
      throw new Error('STORAGE_DRIVER=supabase requiere SUPABASE_URL, SUPABASE_SECRET_KEY y SUPABASE_STORAGE_BUCKET.');
    }
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return new SupabaseObjectStore(client.storage, bucket);
  }

  async upload(path: string, body: Buffer, contentType: string) {
    const { error } = await this.storage.from(this.bucket).upload(path, body, { contentType, upsert: false, cacheControl: '3600' });
    if (!error) return;
    if (isStatus(error, 409)) throw new ConflictException('Ya existe una fotografía guardada en esa ubicación.');
    throw new ServiceUnavailableException('No se pudo guardar la fotografía. Intenta nuevamente.');
  }

  async download(path: string) {
    const { data, error } = await this.storage.from(this.bucket).download(path);
    if (error || !data) {
      if (isStatus(error, 404) || isStatus(error, 400)) throw new NotFoundException('Fotografía no encontrada.');
      throw new ServiceUnavailableException('No se pudo leer la fotografía. Intenta nuevamente.');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async remove(path: string) {
    const { error } = await this.storage.from(this.bucket).remove([path]);
    if (error) throw new ServiceUnavailableException('No se pudo retirar la fotografía del almacenamiento.');
  }
}

export function storageDriverFromEnv(value = process.env.STORAGE_DRIVER): StorageDriver {
  const driver = (value ?? '').trim().toLowerCase() || 'local';
  if (driver !== 'local' && driver !== 'supabase') throw new Error('STORAGE_DRIVER debe ser "local" o "supabase".');
  return driver;
}

@Injectable()
export class PhotoStorageService {
  private readonly logger = new Logger(PhotoStorageService.name);
  readonly driver: StorageDriver;
  private readonly objects?: ObjectStore;
  private readonly uploadDir?: string;

  constructor(@Optional() @Inject(PHOTO_STORAGE_OPTIONS) options?: PhotoStorageOptions) {
    this.driver = options?.driver ?? storageDriverFromEnv();
    this.uploadDir = options?.uploadDir;
    if (this.driver === 'supabase') this.objects = options?.objects ?? SupabaseObjectStore.fromEnv();
    if (!options) this.logger.log(`Fotografías: almacenamiento ${this.driver === 'supabase' ? 'Supabase Storage (bucket privado)' : 'local (UPLOAD_DIR)'}.`);
  }

  localDirectory() {
    return resolve(this.uploadDir ?? process.env.UPLOAD_DIR ?? 'uploads');
  }

  objectPath(jobId: string, photoId: string, extension: PhotoExtension) {
    if (!SAFE_SEGMENT.test(jobId) || !SAFE_SEGMENT.test(photoId) || !(extension in PHOTO_CONTENT_TYPES)) {
      throw new Error('Identificadores de fotografía no válidos para el almacenamiento.');
    }
    return `production/${jobId}/${photoId}.${extension}`;
  }

  // Guarda los bytes ya validados. Con `local` el archivo ya está en UPLOAD_DIR (multer) y no hay storagePath.
  async persist(jobId: string, photoId: string, extension: PhotoExtension, body: Buffer): Promise<string | null> {
    if (this.driver === 'local') return null;
    const path = this.objectPath(jobId, photoId, extension);
    await this.objects!.upload(path, body, PHOTO_CONTENT_TYPES[extension]);
    return path;
  }

  // Compensación si la metadata no se pudo guardar después de subir el objeto.
  async discard(storagePath: string | null) {
    if (!storagePath || this.driver !== 'supabase') return;
    await this.objects!.remove(storagePath).catch(() => this.logger.warn(`No se pudo retirar el objeto huérfano ${storagePath}.`));
  }

  // Transición: con `supabase` se usa storagePath si existe; sin él (o con `local`) se sirve el archivo legado.
  async open(photo: PhotoReference): Promise<PhotoContent> {
    if (this.driver === 'supabase' && photo.storagePath) {
      const extension = photo.storagePath.split('.').at(-1) as PhotoExtension;
      const contentType = PHOTO_CONTENT_TYPES[extension];
      if (!contentType) throw new NotFoundException('Fotografía no encontrada.');
      return { kind: 'object', body: await this.objects!.download(photo.storagePath), contentType };
    }
    const filename = photo.url.split('/').at(-1) ?? '';
    if (!LOCAL_FILENAME.test(filename)) throw new NotFoundException('Fotografía no encontrada.');
    return { kind: 'local', filename, root: this.localDirectory() };
  }
}

export function sendPhoto(response: Response, content: PhotoContent, cacheControl: string) {
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (content.kind === 'object') {
    response.type(content.contentType);
    response.send(content.body);
    return;
  }
  response.sendFile(content.filename, { root: content.root }, (error) => {
    if (error && !response.headersSent) response.status(404).end();
  });
}
