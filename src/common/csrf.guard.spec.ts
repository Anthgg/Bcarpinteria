import { ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function requestContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  it('checks mutating requests against configured origins', () => {
    const request = { method: 'POST', protocol: 'http', headers: { origin: 'http://localhost:8080' }, get: () => 'api.local' };
    expect(guard.canActivate(requestContext(request))).toBe(true);
    expect(() => guard.canActivate(requestContext({ ...request, headers: { origin: 'https://attacker.test' } }))).toThrow('origen');
  });

  it('allows same-origin production requests behind the configured reverse proxy', () => {
    const request = {
      method: 'PATCH', protocol: 'http',
      headers: { origin: 'https://app.example.test', 'x-forwarded-proto': 'https' },
      get: () => 'app.example.test',
    };
    expect(guard.canActivate(requestContext(request))).toBe(true);
  });

  it('leaves safe requests and originless non-browser API calls unchanged', () => {
    expect(guard.canActivate(requestContext({ method: 'GET', headers: { origin: 'https://attacker.test' } }))).toBe(true);
    expect(guard.canActivate(requestContext({ method: 'POST', headers: {} }))).toBe(true);
  });

  it('rejects a cross-origin Referer when Origin is absent', () => {
    expect(() => guard.canActivate(requestContext({
      method: 'DELETE', protocol: 'http', headers: { referer: 'https://attacker.test/form' }, get: () => 'localhost:8080',
    }))).toThrow('origen');
  });
});
