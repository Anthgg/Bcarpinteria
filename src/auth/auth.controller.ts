import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  Get,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './auth.dto';
import { AuthRequest, CurrentUser, Public, AuthUser } from '../common/auth';

const ACCESS_COOKIE = 'carp_access';
const REFRESH_COOKIE = 'carp_refresh';
const isProduction = process.env.NODE_ENV === 'production';
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
  path: '/',
};

@Controller('auth')
export class AuthController {
  private readonly attempts = new Map<string, { count: number; until: number }>();

  constructor(private readonly auth: AuthService) {}

  private setCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie(ACCESS_COOKIE, accessToken, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...cookieOptions,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  private clearCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, cookieOptions);
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const attempts = this.attempts.get(key);
    if (attempts && attempts.until > now && attempts.count >= 8) {
      throw new UnauthorizedException('Demasiados intentos. Espera 15 minutos.');
    }
    try {
      const result = await this.auth.login(dto.email, dto.password, req.headers['user-agent']);
      this.attempts.delete(key);
      this.setCookies(res, result.accessToken, result.refreshToken);
      return { user: result.user };
    } catch (error) {
      const current = this.attempts.get(key);
      this.attempts.set(key, {
        count: current && current.until > now ? current.count + 1 : 1,
        until: now + 15 * 60 * 1000,
      });
      throw error;
    }
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    const result = await this.auth.refresh(token);
    this.setCookies(res, result.accessToken, result.refreshToken);
    return { user: result.user };
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    this.clearCookies(res);
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}
