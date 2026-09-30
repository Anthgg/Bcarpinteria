import { Controller, Get, Query } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { Roles } from '../common/auth';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get() summary(@Query('period') period?: string) {
    const range = period === '7d' || period === '30d' || period === 'month' ? period : 'month';
    return this.dashboard.summary(range);
  }
  @Get('audit') auditLog() { return this.dashboard.auditLog(); }
}
