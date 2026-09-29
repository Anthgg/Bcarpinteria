import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma.module';
import { AccessGuard, RolesGuard } from './common/auth';
import { CsrfGuard } from './common/csrf.guard';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CustomersController, InventoryController, OrdersController, ProductsController, SettingsController, UsersController } from './core/core.controller';
import { CoreService } from './core/core.service';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { DocumentsService } from './documents.service';
import { ProductionController } from './production/production.controller';
import { ProductionService } from './production/production.service';
import { DocumentsController, FilesController } from './public/public.controller';
import { PublicController } from './public/public.controller';
import { PublicService } from './public/public.service';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
  ],
  controllers: [
    AuthController,
    UsersController,
    InventoryController,
    CustomersController,
    ProductsController,
    SettingsController,
    OrdersController,
    ProductionController,
    PublicController,
    FilesController,
    DocumentsController,
    DashboardController,
  ],
  providers: [
    AuthService,
    CoreService,
    ProductionService,
    PublicService,
    DocumentsService,
    DashboardService,
    CsrfGuard,
    AccessGuard,
    RolesGuard,
    { provide: APP_GUARD, useExisting: CsrfGuard },
    { provide: APP_GUARD, useExisting: AccessGuard },
    { provide: APP_GUARD, useExisting: RolesGuard },
  ],
})
export class AppModule {}
