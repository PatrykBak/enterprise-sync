import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class ZeroTrustAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    const authHeader = req.headers['authorization'];

    const expectedToken =
      this.configService.getOrThrow<string>('DEV_SECRET_TOKEN');

    if (authHeader !== expectedToken) {
      throw new UnauthorizedException('Wrong token (Zero Trust).');
    }

    return true;
  }
}
