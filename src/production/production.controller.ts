import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AppRole } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { ProductionService } from './production.service';
import { PHOTO_MAX_BYTES } from '../storage/photo-storage.service';

type BodyObject = Record<string, unknown>;
const uploadDirectory = () => resolve(process.env.UPLOAD_DIR ?? 'uploads');
const imageExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

// multer deja el archivo en UPLOAD_DIR; el servicio valida el contenido y decide el storage definitivo.
export const PHOTO_UPLOAD_OPTIONS: MulterOptions = {
  storage: diskStorage({
    destination: (_request, _file, callback) => {
      const directory = uploadDirectory();
      mkdirSync(directory, { recursive: true });
      callback(null, directory);
    },
    filename: (_request, file, callback) => {
      const extension = imageExtension[file.mimetype as keyof typeof imageExtension];
      callback(null, `${randomUUID()}.${extension ?? 'invalid'}`);
    },
  }),
  limits: { fileSize: PHOTO_MAX_BYTES, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!Object.prototype.hasOwnProperty.call(imageExtension, file.mimetype)) callback(new BadRequestException('Usa una imagen PNG, JPEG o WebP.'), false);
    else callback(null, true);
  },
};

@Controller('production')
@Roles(AppRole.ADMIN, AppRole.TESTER, AppRole.OPERARIO)
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  @Get() list() { return this.production.listJobs(); }
  @Get(':id') get(@Param('id') id: string) { return this.production.getJob(id); }

  @Get('notifications/test-targets')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  pushTestTargets() { return this.production.pushTestTargets(); }

  @Post('notifications/test')
  @Roles(AppRole.ADMIN, AppRole.TESTER)
  sendPushTest(@CurrentUser() actor: AuthUser, @Body() body: BodyObject) {
    return this.production.sendPushTest(actor, String(body.subscriptionId ?? ''));
  }

  @Put(':id/materials')
  configure(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.configure(actor, id, body); }

  @Post(':id/cutting/simulate')
  simulate(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.simulate(actor, id, body); }

  @Post(':id/cutting/:planId/confirm')
  confirmPlan(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Param('planId') planId: string) { return this.production.confirmPlan(actor, id, planId); }

  @Post(':id/cutting/complete')
  completeCut(@CurrentUser() actor: AuthUser, @Param('id') id: string) { return this.production.confirmCut(actor, id); }

  @Post(':id/reservations/release')
  release(@CurrentUser() actor: AuthUser, @Param('id') id: string) { return this.production.releaseReservations(actor, id); }

  @Post(':id/stage')
  stage(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.advanceStage(actor, id, body.stage, body.note); }

  @Post(':id/pause')
  pause(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.pause(actor, id, true, body.note); }

  @Post(':id/resume')
  resume(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.pause(actor, id, false, body.note); }

  @Post(':id/notes')
  addNote(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.addNote(actor, id, body); }

  @Post(':id/incidents')
  incident(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: BodyObject) { return this.production.addIncident(actor, id, body); }

  @Patch('incidents/:id/resolve')
  resolveIncident(@CurrentUser() actor: AuthUser, @Param('id') id: string) { return this.production.resolveIncident(actor, id); }

  @Post(':id/photos')
  @UseInterceptors(FileInterceptor('photo', PHOTO_UPLOAD_OPTIONS))
  photo(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: BodyObject,
  ) {
    return this.production.addPhoto(actor, id, file, body.caption ? String(body.caption) : undefined, body.public === true || body.public === 'true');
  }

  @Patch('photos/:photoId/visibility')
  setPhotoVisibility(@CurrentUser() actor: AuthUser, @Param('photoId') photoId: string, @Body() body: BodyObject) {
    return this.production.setPhotoVisibility(actor, photoId, body.public);
  }
}
