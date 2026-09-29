import { Controller, Get } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { Roles } from '../common/auth';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@Roles(AppRole.ADMIN, AppRole.TESTER)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}
  @Get() summary() { return this.dashboard.summary(); }
  @Get('audit') auditLog() { return this.dashboard.auditLog(); }
}
