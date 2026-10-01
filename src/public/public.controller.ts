import { Body, Controller, Delete, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppRole } from '@prisma/client';
import { Public, Roles } from '../common/auth';
import { PublicService } from './public.service';
import { DocumentsService } from '../documents.service';
import { ProductionService } from '../production/production.service';
import { sendPhoto } from '../storage/photo-storage.service';

@Controller('public/track')
@Public()
export class PublicController {
  constructor(private readonly tracking: PublicService) {}

  @Get(':token')
  track(@Param('token') token: string) { return this.tracking.track(token); }

  @Get(':token/notifications')
  notificationConfig(@Param('token') token: string, @Headers('x-push-endpoint') endpoint?: string) {
    return this.tracking.notificationConfig(token, endpoint);
  }

  @Post(':token/notifications')
  subscribe(@Param('token') token: string, @Body() body: Record<string, unknown>) { return this.tracking.subscribe(token, body); }

  @Delete(':token/notifications')
  unsubscribe(@Param('token') token: string, @Body() body: Record<string, unknown>) { return this.tracking.unsubscribe(token, body.endpoint); }

  @Get(':token/photos/:photoId')
  async photo(@Param('token') token: string, @Param('photoId') photoId: string, @Res() response: Response) {
    // Se revalida en cada vista: si la foto pasa a interna deja de servirse de inmediato.
    sendPhoto(response, await this.tracking.photo(token, photoId), 'private, no-cache');
  }
}

@Controller('files')
export class FilesController {
  constructor(private readonly production: ProductionService) {}

  @Get(':filename')
  async photo(@Param('filename') filename: string, @Res() response: Response) {
    sendPhoto(response, await this.production.internalPhotoFile(filename), 'private, max-age=300');
  }
}

@Controller('orders')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':id/pdf')
  async pdf(@Param('id') id: string, @Res() response: Response) {
    const buffer = await this.documents.orderPdf(id);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="pedido-${id}.pdf"`);
    response.setHeader('Content-Length', buffer.length);
    response.send(buffer);
  }
}
