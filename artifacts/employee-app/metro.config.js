const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Only watch the employee-app and the shared workspace libs —
// exclude other artifacts (marlin-erp, api-server, mockup-sandbox)
// whose node_modules churn (e.g. Vite temp dirs) crash Metro.
// The workspace-root node_modules MUST be watched: pnpm stores every
// package there (.pnpm), and Metro can only resolve files it has
// indexed — without it the expo-router entry itself fails to resolve
// and every platform serves a blank app.
config.watchFolders = [
  projectRoot,
  path.join(workspaceRoot, 'lib'),
  path.join(workspaceRoot, 'node_modules'),
];

// pnpm stores packages under workspaceRoot/node_modules/.pnpm/ and symlinks
// them into each package's node_modules/. Metro in --no-dev (production) mode
// does NOT follow symlinks for bundle URL routing by default, which causes
// HTTP 404 when build.js requests the bundle for 'node_modules/expo-router/entry'.
// Enabling unstable_enableSymlinks makes Metro follow symlinks in resolution so
// the pnpm-managed symlinks resolve correctly in both dev and production builds.
config.resolver.unstable_enableSymlinks = true;

// Resolve modules from the workspace root so shared packages work.
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

module.exports = config;
