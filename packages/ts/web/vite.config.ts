import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait()
  ],
  server: {
    fs: {
      // pkg directory is now local to web/
      allow: ['.'],
    },
  },
  optimizeDeps: {
    include: [
      '@noble/hashes/sha256',
      '@noble/hashes/sha512',
      '@noble/hashes/ripemd160',
      '@noble/hashes/hmac',
    ],
  },
  resolve: {
    alias: {
      '@noble/hashes': path.resolve(__dirname, '../../../node_modules/@noble/hashes'),
    },
  },
});
