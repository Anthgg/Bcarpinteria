import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ProductionService } from '../production/production.service';

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly production: ProductionService,
  ) {}

  private async findOrder(token: string) {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new NotFoundException('Seguimiento no encontrado.');
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: {
        lines: {
          include: {
            job: {
              include: {
                stageHistory: { orderBy: { createdAt: 'asc' } },
                notes: { where: { visibility: 'PUBLIC' }, orderBy: { createdAt: 'desc' } },
                photos: { where: { public: true }, orderBy: { createdAt: 'desc' } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Seguimiento no encontrado.');
    return order;
  }

  async track(token: string) {
    const order = await this.findOrder(token);
    const jobs = order.lines.filter((line) => line.job).map((line) => ({ line, job: line.job! }));
    const latestJobTime = jobs.reduce((latest, entry) => Math.max(latest, entry.job.updatedAt.getTime()), 0);
    const timeline = jobs.flatMap(({ line, job }) => job.stageHistory.map((event) => ({
      product: line.name, stage: event.stage, progress: event.progress, at: event.createdAt,
    }))).sort((a, b) => a.at.getTime() - b.at.getTime());
    const notes = jobs.flatMap(({ line, job }) => job.notes.map((note) => ({ product: line.name, content: note.content, at: note.createdAt })))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const photos = jobs.flatMap(({ line, job }) => job.photos.map((photo) => ({
      id: photo.id, product: line.name, caption: photo.caption,
      url: `/api/public/track/${token}/photos/${photo.id}`, at: photo.createdAt,
    })));
    const progress = jobs.length ? Math.round(jobs.reduce((sum, entry) => sum + entry.job.progress, 0) / jobs.length) : (order.status === 'READY' || order.status === 'DELIVERED' ? 100 : 0);
    return {
      orderNumber: order.code,
      status: order.status,
      products: order.lines.map((line) => ({ name: line.name, quantity: line.quantity, type: line.type })),
      createdAt: order.createdAt,
      updatedAt: new Date(Math.max(order.updatedAt.getTime(), latestJobTime || order.updatedAt.getTime())),
      estimatedAt: order.estimatedAt,
      progress,
      currentStage: jobs.length ? jobs.reduce((leastAdvanced, entry) => entry.job.progress < leastAdvanced.job.progress ? entry : leastAdvanced).job.stage : order.status,
      timeline,
      notes,
      photos,
    };
  }

  async notificationConfig(token: string, endpoint?: string) {
    const order = await this.findOrder(token);
    const configured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
    const subscribed = configured && endpoint && endpoint.startsWith('https://') && endpoint.length <= 2048
      ? Boolean(await this.prisma.pushSubscription.findFirst({
        where: { orderId: order.id, endpoint, enabled: true }, select: { id: true },
      }))
      : false;
    return { enabled: configured, publicKey: process.env.VAPID_PUBLIC_KEY ?? null, subscribed };
  }

  async subscribe(token: string, input: Record<string, unknown>) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
      throw new ServiceUnavailableException('Las notificaciones web no están configuradas.');
    }
    const order = await this.findOrder(token);
    const endpoint = String(input.endpoint ?? '');
    const keys = input.keys as Record<string, unknown> | undefined;
    const p256dh = String(keys?.p256dh ?? '');
    const auth = String(keys?.auth ?? '');
    let validEndpoint = false;
    try { validEndpoint = new URL(endpoint).protocol === 'https:'; } catch { /* invalid endpoint */ }
    if (!validEndpoint || endpoint.length > 2048 || p256dh.length < 20 || auth.length < 8) {
      throw new BadRequestException('La suscripción de notificaciones no es válida.');
    }
    return this.prisma.pushSubscription.upsert({
      where: { orderId_endpoint: { orderId: order.id, endpoint } },
      create: { orderId: order.id, endpoint, p256dh, auth },
      update: { p256dh, auth, enabled: true },
      select: { id: true, enabled: true, createdAt: true },
    });
  }

  async unsubscribe(token: string, endpointValue: unknown) {
    const order = await this.findOrder(token);
    const endpoint = String(endpointValue ?? '');
    await this.prisma.pushSubscription.updateMany({ where: { orderId: order.id, endpoint }, data: { enabled: false } });
    return { ok: true };
  }

  photo(token: string, photoId: string) {
    return this.production.publicPhotoFile(token, photoId);
  }
}
