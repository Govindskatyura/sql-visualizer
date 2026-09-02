// Dev-server middleware. CRA requires this file automatically when it exists
// and hands it the Express app; it is never imported by the bundle, so it does
// not ship to production.
//
// `homepage` in package.json puts the built app under /sql-visualizer/, and the
// dev server mounts it there too. A bare http://localhost:3000/ still resolves
// (index.html links its bundle absolutely), which leaves the app reachable at
// two different URLs locally while production only has one. Redirecting keeps
// local behaviour identical to the deployed site.

const { homepage } = require("../package.json");

/** Path portion of `homepage`, without a trailing slash. Empty when served at root. */
function basePathFromHomepage() {
  if (!homepage) return "";
  try {
    // homepage may be a full URL or a bare path.
    const path = homepage.startsWith("http") ? new URL(homepage).pathname : homepage;
    return path.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

module.exports = function setupDevServer(app) {
  const basePath = basePathFromHomepage();
  if (!basePath || basePath === "/") return;

  // Only the document root is redirected. Broader rules risk catching the dev
  // server's own endpoints (hot-update requests, the HMR websocket).
  app.get(["/", "/index.html"], (req, res) => {
    res.redirect(302, `${basePath}/`);
  });
};
