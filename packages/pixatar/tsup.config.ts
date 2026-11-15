import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    // the vendor sources and the baked wardrobe are bundled in: the package depends on
    // nothing of Pixel Agents at runtime
    dts: { resolve: true },
    sourcemap: true,
    // each config clears only its own files: the two build side by side
    clean: ['index.*'],
    target: 'es2022',
    platform: 'neutral',
  },
  {
    // the pixatar command (Node only), bundled on its own so dist/index.js stays as it was
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    clean: ['cli.*'],
    target: 'es2022',
    platform: 'node',
  },
]);
