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
    // One continuous line of releases; there is no channel concept, so the version
    // alone identifies the build.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5174',
      '/ws': { target: 'ws://localhost:5174', ws: true },
    },
  },
});
