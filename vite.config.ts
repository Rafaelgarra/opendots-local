import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = `${env.TLS_CERT_FILE ? 'https' : 'http'}://127.0.0.1:${env.PORT || '44310'}`;
  return {
    plugins: [react()],
    css: { postcss: { plugins: [darkTheme()] } },
    build: { outDir: 'dist/client' },
    server: {
      strictPort: true,
      host: '127.0.0.1',
      proxy: { '/api': { target: backend, secure: false } },
    },
  };
});
