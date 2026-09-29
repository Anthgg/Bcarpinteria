import { NotFoundException } from '@nestjs/common';
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
  let service: PublicService;

  beforeEach(() => {
    findUnique.mockReset().mockResolvedValue(order);
    service = new PublicService({ order: { findUnique } } as never, { publicPhotoFile: jest.fn() } as never);
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
});
