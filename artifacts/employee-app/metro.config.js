const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Only watch the employee-app and the shared workspace libs —
// exclude other artifacts (marlin-erp, api-server, mockup-sandbox)
// whose node_modules churn (e.g. Vite temp dirs) crash Metro.
config.watchFolders = [
  projectRoot,
  path.join(workspaceRoot, 'lib'),
];

// Resolve modules from the workspace root so shared packages work.
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, 'node_modules'),
  path.join(workspaceRoot, 'node_modules'),
];

module.exports = config;
