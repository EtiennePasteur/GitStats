import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 4300 },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // ECharts pèse l'essentiel du bundle et ne bouge quasiment jamais :
        // l'isoler lui donne son propre cache navigateur, que les mises à jour
        // de l'application n'invalident pas.
        manualChunks: (id: string) => (id.includes('node_modules/echarts') ? 'echarts' : undefined),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
