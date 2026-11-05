import { expect, it } from 'vitest';
import { serverTls } from '../src/server/tls.js';

it('requires HTTPS for local-only LAN access and a complete certificate pair', () => {
  expect(() => serverTls({}, '0.0.0.0', true)).toThrow('HTTPS');
  expect(() =>
    serverTls({ TLS_CERT_FILE: 'fixture' }, '127.0.0.1', true),
  ).toThrow('both');
  expect(serverTls({}, '127.0.0.1', true)).toBeUndefined();
});
