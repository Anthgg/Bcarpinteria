import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { corsOriginsFromEnv } from './security-config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const suppliedOrigin = request.headers.origin;
    const referer = request.headers.referer;
    if (!suppliedOrigin && !referer) return true;

    let origin: string;
    try {
      origin = new URL(suppliedOrigin ?? referer!).origin;
    } catch {
      throw new ForbiddenException('El origen de la solicitud no está permitido.');
    }

    const allowed = corsOriginsFromEnv();
    if (process.env.PUBLIC_BASE_URL) {
      try { allowed.add(new URL(process.env.PUBLIC_BASE_URL).origin); } catch { /* Invalid public URL is rejected by production configuration. */ }
    }
    const forwardedProto = request.headers['x-forwarded-proto'];
    const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim()
      || request.protocol;
    const host = request.get('host');
    if (host) allowed.add(`${protocol}://${host}`);

    if (!allowed.has(origin)) throw new ForbiddenException('El origen de la solicitud no está permitido.');
    return true;
  }
}
