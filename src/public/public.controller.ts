import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { resolve } from 'node:path';
import { AppRole } from '@prisma/client';
import { Public, Roles } from '../common/auth';
import { PublicService } from './public.service';
import { DocumentsService } from '../documents.service';

@Controller('public/track')
@Public()
export class PublicController {
  constructor(private readonly tracking: PublicService) {}

  @Get(':token')
  track(@Param('token') token: string) { return this.tracking.track(token); }

  @Get(':token/notifications')
  notificationConfig(@Param('token') token: string) { return this.tracking.notificationConfig(token); }

  @Post(':token/notifications')
  subscribe(@Param('token') token: string, @Body() body: Record<string, unknown>) { return this.tracking.subscribe(token, body); }

  @Delete(':token/notifications')
  unsubscribe(@Param('token') token: string, @Body() body: Record<string, unknown>) { return this.tracking.unsubscribe(token, body.endpoint); }

  @Get(':token/photos/:photoId')
  async photo(@Param('token') token: string, @Param('photoId') photoId: string, @Res() response: Response) {
    const filename = await this.tracking.photo(token, photoId);
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.sendFile(filename, { root: resolve(process.env.UPLOAD_DIR ?? 'uploads') });
  }
}

@Controller('files')
export class FilesController {
  @Get(':filename')
  photo(@Param('filename') filename: string, @Res() response: Response) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(filename)) return response.status(404).end();
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.sendFile(filename, { root: resolve(process.env.UPLOAD_DIR ?? 'uploads') });
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
