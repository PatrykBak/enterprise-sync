import { Controller, Post, Body, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { IsNotEmpty, IsString } from 'class-validator';
import { timingSafeEqual } from 'crypto';
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

    const secretBuf = Buffer.from(clientSecret);
    const expectedBuf = Buffer.from(expectedSecret);

    if (
      secretBuf.length !== expectedBuf.length ||
      !timingSafeEqual(secretBuf, expectedBuf)
    ) {
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
