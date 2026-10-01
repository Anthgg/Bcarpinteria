import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PublicService } from './public.service';

describe('PublicService tracking', () => {
  const token = 't'.repeat(43);
  const eventAt = new Date('2026-09-29T10:00:00Z');
  const order = {
    id: 'order-id', code: 'PED-00001', status: 'IN_PRODUCTION', trackingToken: token,
    createdAt: eventAt, updatedAt: eventAt, estimatedAt: null, totalCents: 90000,
    customer: { name: 'Private customer' },
    lines: [{
      name: 'Mesa a medida', quantity: 1, type: 'CUSTOM',
      job: {
        stage: 'CUTTING', progress: 30, updatedAt: eventAt,
        stageHistory: [{ stage: 'CUTTING', progress: 30, createdAt: eventAt }],
        notes: [{ content: 'La cubierta quedó lista', createdAt: eventAt, visibility: 'PUBLIC' }],
        photos: [{ id: 'photo-1', caption: 'Corte listo', createdAt: eventAt, public: true }],
      },
    }],
  };
  const findUnique = jest.fn();
  const pushFindFirst = jest.fn();
  const pushUpsert = jest.fn();
  const pushUpdateMany = jest.fn();
  let service: PublicService;
  let priorVapid: Record<string, string | undefined> = {};

  beforeEach(() => {
    priorVapid = Object.fromEntries(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].map((key) => [key, process.env[key]]));
    findUnique.mockReset().mockResolvedValue(order);
    pushFindFirst.mockReset();
    pushUpsert.mockReset();
    pushUpdateMany.mockReset();
    service = new PublicService({
      order: { findUnique },
      pushSubscription: { findFirst: pushFindFirst, upsert: pushUpsert, updateMany: pushUpdateMany },
    } as never, { publicPhotoFile: jest.fn() } as never);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(priorVapid)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns only public order tracking fields and filters notes/photos in the database query', async () => {
    const tracking = await service.track(token);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { trackingToken: token } }));
    const query = findUnique.mock.calls[0][0];
    expect(query.include.lines.include.job.include.notes.where).toEqual({ visibility: 'PUBLIC' });
    expect(query.include.lines.include.job.include.photos.where).toEqual({ public: true });
    expect(tracking).toMatchObject({ orderNumber: 'PED-00001', status: 'IN_PRODUCTION', progress: 30, currentStage: 'CUTTING' });
    expect(tracking.notes).toEqual([{ product: 'Mesa a medida', content: 'La cubierta quedó lista', at: eventAt }]);
    expect(tracking.photos[0].url).toBe(`/api/public/track/${token}/photos/photo-1`);
    expect(tracking).not.toHaveProperty('customer');
    expect(tracking).not.toHaveProperty('totalCents');
    expect(tracking).not.toHaveProperty('trackingToken');
  });

  it('rejects malformed tracking tokens before querying the order', async () => {
    await expect(service.track('sequential-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reports the least advanced product stage for a multi-product order', async () => {
    findUnique.mockResolvedValueOnce({
      ...order,
      lines: [
        { ...order.lines[0], job: { ...order.lines[0].job, stage: 'READY', progress: 100 } },
        {
          name: 'Banco', quantity: 1, type: 'CATALOG',
          job: { stage: 'ORDER_RECEIVED', progress: 0, updatedAt: eventAt, stageHistory: [], notes: [], photos: [] },
        },
      ],
    });

    const tracking = await service.track(token);

    expect(tracking).toMatchObject({ progress: 50, currentStage: 'ORDER_RECEIVED' });
  });

  it('checks an existing subscription only for the token order and endpoint', async () => {
    const previous = {
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    };
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    pushFindFirst.mockResolvedValue({ id: 'subscription-1' });

    try {
      await expect(service.notificationConfig(token, 'https://push.example.invalid/subscription'))
        .resolves.toEqual({ enabled: true, publicKey: 'public-test-key', subscribed: true });
      expect(pushFindFirst).toHaveBeenCalledWith({
        where: { orderId: order.id, endpoint: 'https://push.example.invalid/subscription', enabled: true },
        select: { id: true },
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('upserts by order and endpoint so repeated activation remains idempotent', async () => {
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';
    pushUpsert.mockResolvedValue({ id: 'subscription-1', enabled: true, createdAt: eventAt });

    const body = {
      endpoint: 'https://push.example.invalid/subscription',
      keys: { p256dh: 'a'.repeat(30), auth: 'b'.repeat(12) },
    };
    await service.subscribe(token, body);
    await service.subscribe(token, body);

    expect(pushUpsert).toHaveBeenCalledTimes(2);
    expect(pushUpsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { orderId_endpoint: { orderId: order.id, endpoint: body.endpoint } },
      create: { orderId: order.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
      update: { p256dh: body.keys.p256dh, auth: body.keys.auth, enabled: true },
    }));
  });

  it('rejects non-HTTPS push endpoints', async () => {
    process.env.VAPID_PUBLIC_KEY = 'public-test-key';
    process.env.VAPID_PRIVATE_KEY = 'private-test-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.invalid';

    await expect(service.subscribe(token, {
      endpoint: 'http://push.example.invalid/subscription',
      keys: { p256dh: 'a'.repeat(30), auth: 'b'.repeat(12) },
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(pushUpsert).not.toHaveBeenCalled();
  });

  it('disables one order endpoint without deleting the browser subscription', async () => {
    await expect(service.unsubscribe(token, 'https://push.example.invalid/subscription')).resolves.toEqual({ ok: true });
    expect(pushUpdateMany).toHaveBeenCalledWith({
      where: { orderId: order.id, endpoint: 'https://push.example.invalid/subscription' }, data: { enabled: false },
    });
  });
});
