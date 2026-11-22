import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'zlib';

const PRECOMPRESS_EXTS = new Set(['.js', '.css', '.html', '.svg', '.json', '.tgs']);

function precompressDistPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'precompress-dist-assets',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir || 'dist';
    },
    closeBundle() {
      const rootOut = path.resolve(import.meta.dirname, outDir);
      if (!fs.existsSync(rootOut)) return;

      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          const ext = path.extname(entry.name).toLowerCase();
          if (!PRECOMPRESS_EXTS.has(ext)) continue;

          const raw = fs.readFileSync(fullPath);
          if (raw.length < 1024) continue;

          const br = brotliCompressSync(raw, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 },
          });
          if (br.length < raw.length * 0.95) {
            fs.writeFileSync(`${fullPath}.br`, br);
          }

          const gz = gzipSync(raw, { level: 9 });
          if (gz.length < raw.length * 0.95) {
            fs.writeFileSync(`${fullPath}.gz`, gz);
          }
        }
      };

      walk(rootOut);
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), precompressDistPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
              return 'vendor-react';
            }
            if (
              id.includes('node_modules/socket.io-client/') ||
              id.includes('node_modules/engine.io-client/') ||
              id.includes('node_modules/socket.io-parser/')
            ) {
              return 'vendor-socket';
            }
            if (id.includes('node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
