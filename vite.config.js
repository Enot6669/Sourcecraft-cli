import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const desktopContentPolicy = {
  name: 'desktop-content-policy',
  apply: 'build',
  transformIndexHtml() {
    return [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'",
      },
      injectTo: 'head-prepend',
    }];
  },
};

export default defineConfig({
  plugins: [react(), desktopContentPolicy],
  base: './',
  server: {host: '127.0.0.1', port: 5173, strictPort: true},
});
