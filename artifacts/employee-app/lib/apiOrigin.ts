import { Platform } from 'react-native';

/**
 * Origin for absolute URLs the app hands off to the OS (PDF viewer, share
 * sheet). On web the app is served from the same origin as the API, so the
 * page's own origin is correct; native builds sit outside the web proxy and
 * use the same domain the api-client was pointed at in app/_layout.
 */
export function apiOrigin(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : '';
}
