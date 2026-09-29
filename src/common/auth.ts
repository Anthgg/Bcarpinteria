import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole, User } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma.service';

const configuredSecret = process.env.JWT_SECRET?.trim() || undefined;
if (process.env.NODE_ENV === 'production' && !configuredSecret) {
  throw new Error('JWT_SECRET es obligatorio en producción.');
}
export const JWT_SECRET = configuredSecret ?? randomBytes(48).toString('base64url');

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function signAccessToken(userId: string, sessionId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ sub: userId, sid: sessionId, iat: issuedAt, exp: issuedAt + 900 }));
  const content = `${header}.${payload}`;
  const signature = createHmac('sha256', JWT_SECRET).update(content).digest('base64url');
  return `${content}.${signature}`;
}

export function verifyAccessToken(token: string): AccessClaims {
  if (token.length > 4096) throw new Error('Token too large.');
  const [headerText, payloadText, signatureText, extra] = token.split('.');
  if (!headerText || !payloadText || !signatureText || extra !== undefined) throw new Error('Malformed token.');
  const header = JSON.parse(Buffer.from(headerText, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('Unsupported token algorithm.');
  const content = `${headerText}.${payloadText}`;
  const expected = createHmac('sha256', JWT_SECRET).update(content).digest();
  const supplied = Buffer.from(signatureText, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('Invalid token signature.');
  const claims = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8')) as Partial<AccessClaims> & { exp?: number };
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired or invalid token.');
  }
  return { sub: claims.sub, sid: claims.sid };
}

export type AuthUser = Pick<User, 'id' | 'email' | 'name' | 'role'>;
export type AuthRequest = Request & { user?: AuthUser };

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser | undefined =>
    context.switchToHttp().getRequest<AuthRequest>().user,
);

interface AccessClaims {
  sub: string;
  sid: string;
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;
    const token = request.cookies?.carp_access as string | undefined;
    if (!token && !bearer) throw new UnauthorizedException('Inicia sesión.');

    try {
      const credential = token ?? bearer!;
      const claims = verifyAccessToken(credential);
      const session = await this.prisma.session.findFirst({
        where: { id: claims.sid, revokedAt: null, expiresAt: { gt: new Date() } },
        include: { user: true },
      });
      if (!session || session.userId !== claims.sub || !session.user.active) {
        throw new UnauthorizedException('La sesión venció.');
      }
      const { id, email, name, role } = session.user;
      request.user = { id, email, name, role };
      return true;
    } catch {
      throw new UnauthorizedException('La sesión venció o no es válida.');
    }
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<AuthRequest>().user;
    return user?.role === AppRole.TESTER || (!!user && roles.includes(user.role));
  }
}
