import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Version string surfaced in the UI (the pre-alpha banner). Derived from
// package.json version so the banner, package.json and the release tag can
// never disagree — see scripts/version.sh.
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // 'nightly' when the version carries the -nightly suffix, 'stable' otherwise.
    __APP_CHANNEL__: JSON.stringify(pkg.version.includes('nightly') ? 'nightly' : 'stable'),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5174',
      '/ws': { target: 'ws://localhost:5174', ws: true },
    },
  },
});
