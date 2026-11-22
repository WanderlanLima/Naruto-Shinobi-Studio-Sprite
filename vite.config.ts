import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

function resolveBasePath(): string {
  const raw = (process.env.VITE_BASE_PATH || '').trim();
  if (!raw) return './';
  const normalized = raw.replace(/\/{2,}/g, '/');
  const withLeading =
    normalized.startsWith('/') || normalized.startsWith('./')
      ? normalized
      : `/${normalized}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function computeStaticPackVersion(): string {
  const parts: string[] = [];
  for (const rel of ['public/data/naruto-catalog.json', 'public/data/naruto-atlas-pack.zip']) {
    const full = path.resolve(__dirname, rel);
    try {
      const st = fs.statSync(full);
      parts.push(`${st.size.toString(36)}-${Math.floor(st.mtimeMs / 1000).toString(36)}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('_');
}

export default defineConfig(() => {
  const base = resolveBasePath();
  const staticPackVersion = computeStaticPackVersion();

  return {
    // Uses exact GitHub Pages subpath (/repo/) in CI and relative './' for local/portable builds
    base,
    define: {
      __STATIC_PACK_VERSION__: JSON.stringify(staticPackVersion),
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'icon.svg',
          'apple-touch-icon.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
        ],
        manifest: {
          id: base,
          name: 'Shinobi Sprite Studio',
          short_name: 'ShinobiApp',
          description:
            'Extrator e estúdio de fatiamento de sprites de ninjas, texture atlases e animações Spine.',
          theme_color: '#0B0F17',
          background_color: '#0B0F17',
          display: 'standalone',
          orientation: 'any',
          start_url: base,
          scope: base,
          icons: [
            {
              src: `${base}pwa-192x192.png`,
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}pwa-512x512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: `${base}pwa-maskable-512x512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          globIgnores: ['**/data/**'],
          navigateFallbackDenylist: [/\/data\//, /\/api\//, /\.(?:zip|json|png|webp|mp4|mp3)$/i],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          // Never ship temporary chat attachments into production/GitHub Pages builds
          const distAiStudioAssets = path.resolve(distDir, 'assets/aistudio');
          if (fs.existsSync(distAiStudioAssets)) {
            fs.rmSync(distAiStudioAssets, {recursive: true, force: true});
          }
          // Ensure GitHub Pages serves all static files without Jekyll processing and handles SPA 404s
          if (fs.existsSync(distDir)) {
            fs.writeFileSync(path.resolve(distDir, '.nojekyll'), '');
            const distIndex = path.resolve(distDir, 'index.html');
            const dist404 = path.resolve(distDir, '404.html');
            if (fs.existsSync(distIndex)) {
              fs.copyFileSync(distIndex, dist404);
            }
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
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
