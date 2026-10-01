import { Injectable, Optional } from '@nestjs/common';
import * as fs from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../prisma.service';
import { PhotoStorageService } from '../storage/photo-storage.service';
import type { StorageStatus } from '../storage/photo-storage.service';

export interface HealthReport {
  status: string;
  service: string;
  environment: string;
  database: {
    provider: string;
    connected: boolean;
    message: string;
  };
  storage: StorageStatus;
  excel: {
    file: string;
    path: string;
    exists: boolean;
    readOnly: true;
  };
  timestamp: string;
}

// Solo lecturas: SELECT 1 y metadata del bucket. Nunca escribe (ni SystemProbe) y nunca devuelve
// host, usuario, cadena de conexión, project ref ni claves; los errores se resumen sin el detalle del driver.
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: PhotoStorageService,
  ) {}

  get bdPath(): string {
    return resolve(process.env.BD_PATH ?? './bd/inventario g.xlsx');
  }

  get environment(): string {
    return process.env.APP_ENV ?? 'LOCAL';
  }

  get databaseProvider(): string {
    return this.environment === 'SUPABASE' ? 'PostgreSQL (Supabase)' : 'PostgreSQL (Docker local)';
  }

  async checkDatabase(): Promise<HealthReport['database']> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { provider: this.databaseProvider, connected: true, message: 'PostgreSQL conectado' };
    } catch {
      return { provider: this.databaseProvider, connected: false, message: 'PostgreSQL no disponible' };
    }
  }

  async check(): Promise<HealthReport> {
    const path = this.bdPath;

    return {
      status: 'API OK',
      service: 'carpinteria-backend',
      environment: this.environment,
      database: await this.checkDatabase(),
      storage: this.storage ? await this.storage.status() : { driver: 'local', status: 'configurado' },
      excel: {
        file: 'inventario g.xlsx',
        path,
        exists: fs.existsSync(path),
        readOnly: true,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
