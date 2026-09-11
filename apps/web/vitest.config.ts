import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  // vite.config.ts inlines this from VERCEL_ENV as a literal. Here it resolves
  // to a global instead, so a test can flip it — the guard is only worth having
  // if both sides of it are exercised.
  define: {
    __VENDOR_PREVIEW__: 'globalThis.__VENDOR_PREVIEW__',
    // A fixed placeholder — no real vendor checkout under vitest, and tests
    // that reach this (loadFurnitureCategories() et al.) only care that it's
    // a stable, well-formed commit-shaped string, not the real pin.
    __PIXEL_AGENTS_COMMIT__: JSON.stringify('0'.repeat(40)),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
  },
});
