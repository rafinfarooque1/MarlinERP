// Production-build Metro bundle entry point.
//
// Metro's HTTP bundle URL handler resolves the URL path against the project
// root using raw filesystem lookup — it does NOT follow pnpm symlinks even
// with unstable_enableSymlinks=true. The canonical entry path
// "node_modules/expo-router/entry" is a pnpm symlink, so Metro returns 404
// when build.js requests that URL.
//
// This real (non-symlink) file lives directly in the project root, so Metro
// can find it via "/_production-entry.bundle" without any symlink traversal.
// Once Metro has the file, its module resolver DOES follow pnpm symlinks and
// resolves 'expo-router/entry' correctly into the pnpm store.
import 'expo-router/entry';
