import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from './jwt.strategy';

interface LoginDto {
  clientId: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly jwtService: JwtService) {}

  @Post('login')
  login(@Body() loginDto: LoginDto): { accessToken: string } {
    const { clientId } = loginDto;

    if (!clientId) {
      throw new BadRequestException('clientId is required');
    }

    const payload: JwtPayload = {
      sub: clientId,
      role: 'admin',
    };

    const accessToken = this.jwtService.sign(payload);

    return { accessToken };
  }
}
