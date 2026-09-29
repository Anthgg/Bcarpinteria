import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { resolve } from 'path';
import { PrismaService } from '../prisma.service';

export interface HealthReport {
  status: string;
  service: string;
  environment: string;
  database: {
    connected: boolean;
    message: string;
  };
  excel: {
    file: string;
    path: string;
    exists: boolean;
    readOnly: true;
  };
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  get bdPath(): string {
    return resolve(process.env.BD_PATH ?? './bd/inventario g.xlsx');
  }

  get environment(): string {
    return process.env.APP_ENV ?? 'LOCAL';
  }

  async checkDatabase(): Promise<{ connected: boolean; message: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { connected: true, message: 'PostgreSQL conectado' };
    } catch (error) {
      return {
        connected: false,
        message: `PostgreSQL no disponible: ${(error as Error).message}`,
      };
    }
  }

  async check(): Promise<HealthReport> {
    const path = this.bdPath;

    return {
      status: 'API OK',
      service: 'carpinteria-backend',
      environment: this.environment,
      database: await this.checkDatabase(),
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
