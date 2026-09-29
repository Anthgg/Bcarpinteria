import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { compare } from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { AuthUser, signAccessToken } from '../common/auth';

const REFRESH_DAYS = 30;
const DUMMY_PASSWORD_HASH = '$2b$12$WFEVMYyYSbwVV0eyZ6s8..gbkWb4b4seJh2JXjVhagXDI53CTF/5i';
const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private async issue(user: AuthUser, sessionId?: string, oldRefresh?: string) {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000);
    const session = sessionId
      ? await this.prisma.session.update({
          where: { id: sessionId },
          data: { tokenHash: hashToken(refreshToken), expiresAt, revokedAt: null },
        })
      : await this.prisma.session.create({
          data: {
            userId: user.id,
            tokenHash: hashToken(refreshToken),
            expiresAt,
          },
        });
    const accessToken = signAccessToken(user.id, session.id);
    void oldRefresh;
    return { accessToken, refreshToken };
  }

  async login(email: string, password: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    const passwordMatches = await compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.active || !passwordMatches) {
      await this.prisma.auditLog.create({
        data: { action: 'LOGIN_FAILED', entity: 'User', metadata: { email: email.trim().toLowerCase() } },
      });
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }
    const publicUser = { id: user.id, email: user.email, name: user.name, role: user.role };
    const tokens = await this.issue(publicUser);
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(tokens.refreshToken) } });
    if (session && userAgent) {
      await this.prisma.session.update({ where: { id: session.id }, data: { userAgent: userAgent.slice(0, 240) } });
    }
    await this.prisma.auditLog.create({
      data: { userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id },
    });
    return { user: publicUser, ...tokens };
  }

  async refresh(refreshToken?: string) {
    if (!refreshToken) throw new UnauthorizedException('La sesión venció.');
    const session = await this.prisma.session.findFirst({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!session || !session.user.active) throw new UnauthorizedException('La sesión venció.');
    const user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role,
    };
    const tokens = await this.issue(user, session.id, refreshToken);
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: { tokenHash: hashToken(tokens.refreshToken) },
    });
    await this.prisma.auditLog.create({
      data: { userId: user.id, action: 'SESSION_REFRESH', entity: 'Session', entityId: updated.id },
    });
    return { user, ...tokens };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) return;
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!session || session.revokedAt) return;
    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: { userId: session.userId, action: 'LOGOUT', entity: 'Session', entityId: session.id },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, active: true },
    });
    if (!user?.active) throw new UnauthorizedException('La cuenta está inactiva.');
    return user;
  }
}
