import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthUser } from '../common/auth';
import { PhotoStorageService } from '../storage/photo-storage.service';
import { ProductionService } from './production.service';

const actor: AuthUser = { id: 'user-1', email: 'admin@local.test', name: 'Admin', role: AppRole.ADMIN };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const store = () => ({
  upload: jest.fn().mockResolvedValue(undefined),
  download: jest.fn().mockResolvedValue(png),
  remove: jest.fn().mockResolvedValue(undefined),
});
const prismaFor = (create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data }))) => ({
  productionJob: { findUnique: jest.fn().mockResolvedValue({ id: 'job-1', orderId: 'order-1' }) },
  productionPhoto: { create },
});

describe('ProductionService photo storage', () => {
  let directory: string;
  const upload = async (name: string, body: Buffer = png) => {
    await writeFile(join(directory, name), body);
    return { filename: name, destination: directory, mimetype: 'image/png' } as Express.Multer.File;
  };

  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'carpinteria-storage-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('keeps the local driver behaviour: file stays in UPLOAD_DIR and storagePath is null', async () => {
    const name = '550e8400-e29b-41d4-a716-446655440010.png';
    const prisma = prismaFor();
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'local' }));

    const photo = await service.addPhoto(actor, 'job-1', await upload(name), undefined, false);

    expect(photo).toMatchObject({ id: name.slice(0, 36), url: `/api/files/${name}`, storagePath: null });
    await expect(access(join(directory, name))).resolves.toBeUndefined();
  });

  it('uploads to Supabase before writing metadata and removes the temporary file', async () => {
    const name = '550e8400-e29b-41d4-a716-446655440011.png';
    const objects = store();
    const prisma = prismaFor();
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'supabase', objects }));

    const photo = await service.addPhoto(actor, 'job-1', await upload(name), 'Corte', false);

    const path = `production/job-1/${name.slice(0, 36)}.png`;
    expect(objects.upload).toHaveBeenCalledWith(path, png, 'image/png');
    expect(prisma.productionPhoto.create).toHaveBeenCalledWith({ data: expect.objectContaining({ storagePath: path, url: `/api/files/${name}` }) });
    expect(objects.upload.mock.invocationCallOrder[0]).toBeLessThan(prisma.productionPhoto.create.mock.invocationCallOrder[0]);
    expect(photo.storagePath).toBe(path);
    await expect(access(join(directory, name))).rejects.toThrow();
  });

  it('does not write metadata when the storage upload fails', async () => {
    const name = '550e8400-e29b-41d4-a716-446655440012.png';
    const objects = store();
    objects.upload.mockRejectedValue(new ServiceUnavailableException('No se pudo guardar la fotografía. Intenta nuevamente.'));
    const prisma = prismaFor();
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'supabase', objects }));

    await expect(service.addPhoto(actor, 'job-1', await upload(name))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.productionPhoto.create).not.toHaveBeenCalled();
    await expect(access(join(directory, name))).rejects.toThrow();
  });

  it('removes the uploaded object when the metadata cannot be saved', async () => {
    const name = '550e8400-e29b-41d4-a716-446655440013.png';
    const objects = store();
    const prisma = prismaFor(jest.fn().mockRejectedValue(new Error('database unavailable')));
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'supabase', objects }));

    await expect(service.addPhoto(actor, 'job-1', await upload(name))).rejects.toThrow('database unavailable');
    expect(objects.remove).toHaveBeenCalledWith(`production/job-1/${name.slice(0, 36)}.png`);
  });

  it('rejects content that is not really an image before touching the bucket', async () => {
    const name = '550e8400-e29b-41d4-a716-446655440014.png';
    const objects = store();
    const prisma = prismaFor();
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'supabase', objects }));

    await expect(service.addPhoto(actor, 'job-1', await upload(name, Buffer.from('<svg onload=alert(1)>')))).rejects.toThrow('no coincide');
    expect(objects.upload).not.toHaveBeenCalled();
    expect(prisma.productionPhoto.create).not.toHaveBeenCalled();
  });
});

describe('ProductionService photo access', () => {
  it('serves public photos only for the right tracking token and stops immediately after privatizing', async () => {
    const photos = [{ id: 'photo-1', jobId: 'job-1', public: true, token: 'token-ok', url: '/api/files/550e8400-e29b-41d4-a716-446655440015.png', storagePath: 'production/job-1/photo-1.png' }];
    type Where = { id: string; public?: boolean; job: { order: { trackingToken: string } } };
    const prisma = {
      productionPhoto: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: Where }) => Promise.resolve(photos.find((photo) =>
          photo.id === where.id && (where.public === undefined || photo.public === where.public) && photo.token === where.job.order.trackingToken) ?? null)),
        findUnique: jest.fn().mockImplementation(({ where }) => Promise.resolve({ ...photos.find((photo) => photo.id === where.id), job: { orderId: 'order-1' } })),
        update: jest.fn().mockImplementation(({ where, data }) => {
          Object.assign(photos.find((photo) => photo.id === where.id)!, data);
          return Promise.resolve({ id: where.id, ...data });
        }),
      },
    };
    const objects = store();
    const service = new ProductionService(prisma as never, { audit: jest.fn() } as never, new PhotoStorageService({ driver: 'supabase', objects }));

    await expect(service.publicPhotoFile('token-ok', 'photo-1')).resolves.toMatchObject({ kind: 'object', contentType: 'image/png' });
    await expect(service.publicPhotoFile('token-wrong', 'photo-1')).rejects.toBeInstanceOf(NotFoundException);
    await service.setPhotoVisibility(actor, 'photo-1', false);
    await expect(service.publicPhotoFile('token-ok', 'photo-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(objects.download).toHaveBeenCalledTimes(1);
    expect(prisma.productionPhoto.findFirst.mock.calls.every(([query]) => query.where.public === true)).toBe(true);
  });

  it('only serves internal files that belong to a registered photo', async () => {
    const prisma = { productionPhoto: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new ProductionService(prisma as never, {} as never, new PhotoStorageService({ driver: 'local' }));

    await expect(service.internalPhotoFile('../../.env')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.productionPhoto.findFirst).not.toHaveBeenCalled();
    await expect(service.internalPhotoFile('550e8400-e29b-41d4-a716-446655440016.png')).rejects.toBeInstanceOf(NotFoundException);
  });
});
