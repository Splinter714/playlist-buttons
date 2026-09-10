import { defineConfig } from 'vite';

// base must match the GitHub Pages path: https://splinter714.github.io/playlist-buttons/
// The dev server binds 127.0.0.1:5173 on purpose — Spotify only accepts https redirect
// URIs, with the loopback IP as the single http exception. "localhost" is NOT accepted.
export default defineConfig({
  base: '/playlist-buttons/',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
