import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async check() {
    const report = await this.health.check();

    if (!report.database.connected) {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
