import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '@prisma/client';
import { RolesGuard } from './auth';

describe('RolesGuard', () => {
  const contextFor = (role: AppRole) => ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  }) as unknown as ExecutionContext;

  it('allows an operario on production routes and blocks admin-only routes', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([AppRole.OPERARIO]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(contextFor(AppRole.OPERARIO))).toBe(true);
    reflector.getAllAndOverride = jest.fn().mockReturnValue([AppRole.ADMIN]);
    expect(guard.canActivate(contextFor(AppRole.OPERARIO))).toBe(false);
  });

  it('keeps TESTER independent and grants it system-wide access', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([AppRole.OPERARIO]) } as unknown as Reflector;
    expect(new RolesGuard(reflector).canActivate(contextFor(AppRole.TESTER))).toBe(true);
  });
});
