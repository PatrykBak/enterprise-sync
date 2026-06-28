import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('health')
export class HealthController {
  @Get('liveness')
  @SkipThrottle()
  checkLiveness(): { status: string } {
    return { status: 'ok' };
  }
}
