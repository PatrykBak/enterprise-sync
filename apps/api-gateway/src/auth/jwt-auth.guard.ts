import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

interface JwtAuthInfo {
  message?: string;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false | null,
    info: JwtAuthInfo | Error | null,
  ): TUser {
    if (err || !user) {
      const details =
        info?.message ||
        (info instanceof Error ? info.message : err?.message || 'Unauthorized');
      throw (
        err || new UnauthorizedException(`Authentication failed: ${details}`)
      );
    }
    return user;
  }
}
