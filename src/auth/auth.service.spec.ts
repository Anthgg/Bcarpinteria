import { hash } from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('creates a hashed refresh session and records a successful local login', async () => {
    const passwordHash = await hash('Local-Demo-Password-2026!', 4);
    const user = { id: 'user-1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', active: true, passwordHash };
    const session = { id: 'session-1' };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      session: {
        create: jest.fn().mockResolvedValue(session),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn().mockResolvedValue(session),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new AuthService(prisma as never);

    const result = await service.login(' ADMIN@example.test ', 'Local-Demo-Password-2026!', 'unit-test');

    expect(result.user).toEqual({ id: user.id, email: user.email, name: user.name, role: user.role });
    expect(result.accessToken.split('.')).toHaveLength(3);
    expect(result.accessToken).not.toContain('Local-Demo-Password-2026!');
    expect(result.refreshToken).toHaveLength(64);
    expect(prisma.session.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', tokenHash: expect.not.stringContaining(result.refreshToken) }) }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN', userId: 'user-1' }) }));
  });

  it('does not reveal whether a user exists when local credentials fail', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const service = new AuthService(prisma as never);
    await expect(service.login('missing@example.test', 'No-such-password')).rejects.toThrow('Correo o contraseña incorrectos.');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_FAILED' }) }));
  });
});
