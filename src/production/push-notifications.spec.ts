import { AppRole, NoteVisibility, ProductionStage, ProductionStatus } from '@prisma/client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthUser } from '../common/auth';
import { ProductionService } from './production.service';

const mockSendNotification = jest.fn();
jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
}));

const actor: AuthUser = { id: 'admin-1', email: 'admin@local.test', name: 'Admin', role: AppRole.ADMIN };
const job = {
  id: 'job-1', orderId: 'order-1', orderLineId: 'line-1',
  stage: ProductionStage.ORDER_RECEIVED, status: ProductionStatus.ACTIVE,
  progress: 0, orderLine: { name: 'Mesa A013' },
};

function pushSpy(service: ProductionService) {
  return jest.spyOn(service as unknown as { notify: (orderId: string, event: unknown) => Promise<void> }, 'notify')
    .mockResolvedValue(undefined);
}

describe('client-visible Web Push events', () => {
  let directory: string;
  const savedEnvironment: Record<string, string | undefined> = {};

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'carpinteria-push-'));
    mockSendNotification.mockReset();
    for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'PUSH_TEST_ORDER_CODES']) {
      savedEnvironment[key] = process.env[key];
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('sends one product-specific public stage event after the stage transaction', async () => {
    const tx = {
      productionJob: { findUnique: jest.fn().mockResolvedValue(job), update: jest.fn().mockResolvedValue({}) },
      productionStageHistory: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((run: (transaction: typeof tx) => unknown) => run(tx)) };
    const service = new ProductionService(prisma as never, {} as never);
    jest.spyOn(service, 'getJob').mockResolvedValue({ id: job.id } as never);
    const notify = pushSpy(service);

    await service.advanceStage(actor, job.id, ProductionStage.MATERIALS_RESERVED);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(job.orderId, {
      type: 'stage', productName: 'Mesa A013', stage: ProductionStage.MATERIALS_RESERVED,
    });
  });

  it('sends one global ready event only after every order line is complete', async () => {
    const readyJob = { ...job, stage: ProductionStage.QUALITY_CONTROL, progress: 90 };
    const tx = {
      productionJob: {
        findUnique: jest.fn().mockResolvedValue(readyJob), update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      productionStageHistory: { create: jest.fn().mockResolvedValue({}) },
      order: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: jest.fn((run: (transaction: typeof tx) => unknown) => run(tx)) };
    const service = new ProductionService(prisma as never, {} as never);
    jest.spyOn(service, 'getJob').mockResolvedValue({ id: job.id } as never);
    const notify = pushSpy(service);

    await service.advanceStage(actor, job.id, ProductionStage.READY);

    expect(tx.productionJob.count).toHaveBeenCalledTimes(1);
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: job.orderId }, data: { status: 'READY' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(job.orderId, { type: 'ready' });
  });

  it('does not send a global ready event while another product remains unfinished', async () => {
    const readyJob = { ...job, stage: ProductionStage.QUALITY_CONTROL, progress: 90 };
    const tx = {
      productionJob: {
        findUnique: jest.fn().mockResolvedValue(readyJob), update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1),
      },
      productionStageHistory: { create: jest.fn().mockResolvedValue({}) },
      order: { update: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new ProductionService({ $transaction: (run: (transaction: typeof tx) => unknown) => run(tx) } as never, {} as never);
    jest.spyOn(service, 'getJob').mockResolvedValue({ id: job.id } as never);
    const notify = pushSpy(service);

    await service.advanceStage(actor, job.id, ProductionStage.READY);

    expect(tx.order.update).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies only for public notes and never includes note text in the push event', async () => {
    const noteService = (visibility: NoteVisibility) => {
      const prisma = {
        productionJob: { findUnique: jest.fn().mockResolvedValue(job) },
        productionNote: { create: jest.fn().mockResolvedValue({ id: 'note-1', content: 'Contenido de nota QA', visibility }) },
      };
      const core = { audit: jest.fn().mockResolvedValue(undefined) };
      const service = new ProductionService(prisma as never, core as never);
      return { service, notify: pushSpy(service) };
    };

    const publicNote = noteService(NoteVisibility.PUBLIC);
    await publicNote.service.addNote(actor, job.id, { visibility: 'PUBLIC', content: 'Contenido de nota QA' });
    expect(publicNote.notify).toHaveBeenCalledWith(job.orderId, { type: 'public-update' });
    expect(JSON.stringify(publicNote.notify.mock.calls[0])).not.toContain('Contenido de nota QA');

    const internalNote = noteService(NoteVisibility.INTERNAL);
    await internalNote.service.addNote(actor, job.id, { visibility: 'INTERNAL', content: 'Nota privada QA' });
    expect(internalNote.notify).not.toHaveBeenCalled();
  });

  it.each([true, false])('notifies for a photo only when public=%s', async (isPublic) => {
    const filename = `550e8400-e29b-41d4-a716-44665544000${isPublic ? '1' : '2'}.png`;
    await writeFile(join(directory, filename), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const prisma = {
      productionJob: { findUnique: jest.fn().mockResolvedValue(job) },
      productionPhoto: { create: jest.fn().mockResolvedValue({ id: 'photo-1', jobId: job.id, public: isPublic, caption: 'Caption QA' }) },
    };
    const core = { audit: jest.fn().mockResolvedValue(undefined) };
    const service = new ProductionService(prisma as never, core as never);
    const notify = pushSpy(service);

    await service.addPhoto(actor, job.id, {
      filename, destination: directory, mimetype: 'image/png',
    } as Express.Multer.File, 'Caption QA', isPublic);

    if (isPublic) expect(notify).toHaveBeenCalledWith(job.orderId, { type: 'public-photo' });
    else expect(notify).not.toHaveBeenCalled();
  });

  it.each([404, 410])('disables a subscription that expires with %i without logging subscription keys', async (statusCode) => {
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    mockSendNotification.mockRejectedValue({ statusCode });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new ProductionService({ pushSubscription: { updateMany } } as never, {} as never);
    const delivered = await (service as unknown as { deliverPush: (...args: unknown[]) => Promise<boolean> }).deliverPush(
      { id: 'subscription-1', endpoint: 'https://push.example.invalid/token', p256dh: 'private-key-material', auth: 'private-auth-material' },
      { id: job.orderId, code: 'PED-00007', trackingToken: 't'.repeat(43) },
      { type: 'stage', productName: 'Mesa A013', stage: ProductionStage.ASSEMBLY },
    );

    expect(delivered).toBe(false);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'subscription-1', enabled: true }, data: { enabled: false } });
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mockSendNotification.mock.calls[0][1]));
    expect(payload).toMatchObject({ title: 'Tu pedido avanzó', body: 'Mesa A013 ahora está en Ensamblaje · 50%.' });
    expect(JSON.stringify(payload)).not.toContain('private-key-material');
    expect(JSON.stringify(payload)).not.toContain('private-auth-material');
    expect(JSON.stringify(payload)).not.toContain(job.orderId);
  });

  it('privatizes a selected photo through the audited service path without deleting its file', async () => {
    const photo = { id: 'photo-qa', jobId: job.id, public: true, job: { orderId: job.orderId } };
    const findUnique = jest.fn().mockResolvedValue(photo);
    const update = jest.fn().mockResolvedValue({ id: photo.id, public: false });
    const audit = jest.fn().mockResolvedValue(undefined);
    const service = new ProductionService({ productionPhoto: { findUnique, update } } as never, { audit } as never);
    const notify = pushSpy(service);

    await expect(service.setPhotoVisibility(actor, photo.id, false)).resolves.toEqual({ id: photo.id, public: false });

    expect(update).toHaveBeenCalledWith({ where: { id: photo.id }, data: { public: false } });
    expect(audit).toHaveBeenCalledWith(actor.id, 'PRODUCTION_PHOTO_VISIBILITY_CHANGED', 'ProductionPhoto', photo.id, {
      jobId: job.id, fromPublic: true, public: false,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('restricts test push targets to the local QA order allowlist and returns no subscription keys', async () => {
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    process.env.PUSH_TEST_ORDER_CODES = 'PED-00007, PED-00008';
    const findMany = jest.fn().mockResolvedValue([{ id: 'subscription-1', createdAt: new Date(), order: { code: 'PED-00007', lines: [{ name: 'Mesa A013' }] } }]);
    const service = new ProductionService({ pushSubscription: { findMany } } as never, {} as never);

    const settings = await service.pushTestTargets();

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true, order: { code: { in: ['PED-00007', 'PED-00008'] } } },
    }));
    expect(settings.targets).toMatchObject([{ id: 'subscription-1', orderCode: 'PED-00007', products: ['Mesa A013'] }]);
    expect(JSON.stringify(settings)).not.toContain('endpoint');
    expect(JSON.stringify(settings)).not.toContain('p256dh');
    expect(JSON.stringify(settings)).not.toContain('auth');
  });

  it('sends a push test to exactly one selected QA subscription', async () => {
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    process.env.PUSH_TEST_ORDER_CODES = 'PED-00007,PED-00008';
    mockSendNotification.mockResolvedValue(undefined);
    const subscription = {
      id: 'subscription-qa', endpoint: 'https://push.example.invalid/token', p256dh: 'p256dh-qa', auth: 'auth-qa', enabled: true,
      order: { id: 'order-qa', code: 'PED-00007', trackingToken: 't'.repeat(43) },
    };
    const findFirst = jest.fn().mockResolvedValue(subscription);
    const audit = jest.fn().mockResolvedValue(undefined);
    const service = new ProductionService({ pushSubscription: { findFirst } } as never, { audit } as never);

    await expect(service.sendPushTest(actor, subscription.id)).resolves.toEqual({ sent: true, orderCode: 'PED-00007' });

    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: subscription.id, enabled: true, order: { code: { in: ['PED-00007', 'PED-00008'] } } },
    }));
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mockSendNotification.mock.calls[0][1]));
    expect(payload).toMatchObject({
      title: 'Aviso de prueba', body: 'Las notificaciones del taller están conectadas.',
      data: { url: expect.stringContaining('/seguimiento/') },
    });
    expect(audit).toHaveBeenCalledWith(actor.id, 'WEB_PUSH_TEST_SENT', 'PushSubscription', subscription.id, {
      order: 'PED-00007', result: 'delivered',
    });
  });
});
