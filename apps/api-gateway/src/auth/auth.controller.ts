import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type { JwtPayload } from './jwt.strategy';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() loginDto: LoginDto): { accessToken: string } {
    const { clientId, clientSecret } = loginDto;
    const expectedClientId =
      this.configService.get<string>('EXPECTED_CLIENT_ID') ?? 'admin-client';
    const expectedSecret =
      this.configService.getOrThrow<string>('DEV_SECRET_TOKEN');

    if (clientId !== expectedClientId) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    const secretHash = createHash('sha256').update(clientSecret).digest();
    const expectedHash = createHash('sha256').update(expectedSecret).digest();

    if (!timingSafeEqual(secretHash, expectedHash)) {
      throw new UnauthorizedException('Invalid client credentials');
    }

    const payload: JwtPayload = {
      sub: clientId,
      role: 'admin',
    };

    const accessToken = this.jwtService.sign(payload);

    return { accessToken };
  }
}
