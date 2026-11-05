import { readFileSync } from 'node:fs';
import { createBcService } from './bc-service.js';

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const server = createBcService({
  database: required('BC_DATABASE_PATH'),
  token: readFileSync(required('BC_TOKEN_FILE'), 'utf8').trim(),
  tls: {
    cert: readFileSync(required('BC_TLS_CERT_FILE')),
    key: readFileSync(required('BC_TLS_KEY_FILE')),
    minVersion: 'TLSv1.2',
  },
  modelUrl: process.env.BC_QWEN_URL,
  model: process.env.BC_QWEN_MODEL ?? 'agente',
  modelToken: process.env.BC_QWEN_TOKEN,
});
server.listen(
  Number(process.env.BC_PORT ?? '44311'),
  process.env.BC_HOST ?? '127.0.0.1',
  () => console.log('BC-250 HTTPS persistence and Qwen endpoint ready.'),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
    }, 10_000).unref();
  });
