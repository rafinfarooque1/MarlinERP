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

// Resolve modules from the workspace root so shared packages work.
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

module.exports = config;
