import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: 'admin' | 'user';
  };
}

@Injectable()
export class ZeroTrustAuthGuard implements CanActivate {
  private readonly expectedBuffer: Buffer;

  constructor(private readonly configService: ConfigService) {
    this.expectedBuffer = Buffer.from(
      this.configService.getOrThrow<string>('DEV_SECRET_TOKEN'),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Invalid or missing Authorization header.',
      );
    }

    const token = authHeader.slice(7);
    const tokenBuffer = Buffer.from(token);

    if (
      tokenBuffer.length !== this.expectedBuffer.length ||
      !timingSafeEqual(tokenBuffer, this.expectedBuffer)
    ) {
      throw new UnauthorizedException('Wrong token (Zero Trust).');
    }

    req.user = { id: 'system-service-account', role: 'admin' };

    return true;
  }
}
