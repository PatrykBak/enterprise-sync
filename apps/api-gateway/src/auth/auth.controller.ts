import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IsNotEmpty, IsString } from 'class-validator';
import { createHash, timingSafeEqual } from 'crypto';
import type { JwtPayload } from './jwt.strategy';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  clientId!: string;

  @IsString()
  @IsNotEmpty()
  clientSecret!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  @Post('login')
  login(@Body() loginDto: LoginDto): { accessToken: string } {
    const { clientId, clientSecret } = loginDto;
    const expectedSecret =
      this.configService.get<string>('DEV_SECRET_TOKEN') || 'dev-secret-token';

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
