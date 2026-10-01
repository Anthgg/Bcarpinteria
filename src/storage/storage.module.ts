import { Module } from '@nestjs/common';
import { PhotoStorageService } from './photo-storage.service';

// Una sola instancia del almacenamiento de fotos para la API y /api/health.
@Module({
  providers: [PhotoStorageService],
  exports: [PhotoStorageService],
})
export class StorageModule {}
