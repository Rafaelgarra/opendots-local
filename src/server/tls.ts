import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

export function serverTls(
  env: Record<string, string | undefined>,
  host: string,
  localOnly: boolean,
) {
  const cert = env.TLS_CERT_FILE?.trim();
  const key = env.TLS_KEY_FILE?.trim();
  if (!!cert !== !!key)
    throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE.');
  if (localOnly && !['127.0.0.1', '::1', 'localhost'].includes(host) && !cert)
    throw new Error(
      'Private LAN access requires HTTPS. Run the LAN setup script first.',
    );
  return cert && key
    ? {
        createServer,
        serverOptions: { cert: readFileSync(cert), key: readFileSync(key) },
      }
    : undefined;
}
