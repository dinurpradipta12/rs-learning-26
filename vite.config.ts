import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build id unik tiap build/deploy, ditulis ke dist/version.json. Klien
// melakukan polling file ini; saat deploy baru ke Cloudflare selesai, buildId
// berubah dan semua klien yang masih terbuka menampilkan notif "versi baru".
const buildId = `${Date.now()}`;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId }),
        });
      },
    },
  ],
});
