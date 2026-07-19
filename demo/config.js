// Baked-in demo configuration.
//
// The hosted chat page talks to ONE kb-server, and the URL is compiled into the
// page here rather than typed into settings. Loaded before app.js.
//
//   * GitHub Pages / any hosted copy → this baked URL (below).
//   * Local `pnpm run demo` on localhost → app.js overrides to http://localhost:38117
//     when this value is left at the Fly default, so local dev still works.
//
// To point a deployment at a different server, the Pages workflow rewrites the
// URL on the right-hand side from the `KB_DEMO_SERVER_URL` repo variable when set
// (see .github/workflows/pages.yml); otherwise this committed default ships.
window.__KB_SERVER__ = 'https://kb-demo.fly.dev'
