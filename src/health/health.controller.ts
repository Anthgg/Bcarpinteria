import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/auth';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  async check() {
    const report = await this.health.check();

    if (!report.database.connected) {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
