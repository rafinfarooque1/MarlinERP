import { ScrollViewStyleReset } from 'expo-router/build/static/html';
import React from 'react';

/**
 * Web HTML root for the Expo app.
 *
 * The inline classic <script> at the top of <head> suppresses
 * ResizeObserver-loop error events BEFORE any module script can register a
 * listener. These events fire constantly from RN-Web layout passes; they carry
 * no Error object and are NOT real crashes. Without this guard, React Native
 * Web's global window.onerror handler catches them and emits
 * "An uncaught exception occurred but the error was not an error object",
 * which the Replit platform misreads as "artifact crashed with a runtime error"
 * and generates an automated prompt even though the app is functioning normally.
 *
 * stopImmediatePropagation alone is not enough: without preventDefault() the
 * browser still surfaces the event at the devtools-protocol level. Other
 * error/unhandledrejection events without an Error object are warned, not
 * suppressed, so genuine issues are still visible.
 */
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/* Suppress ResizeObserver loop noise — must be classic script, must be first */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  window.addEventListener('error', function(evt) {
    if (!evt.error && evt.message && /ResizeObserver loop/i.test(evt.message)) {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      return;
    }
    if (!evt.error) {
      console.warn('[error-event without Error object]', evt.message, evt);
    }
  }, true);
  window.addEventListener('unhandledrejection', function(evt) {
    if (evt.reason && !(evt.reason instanceof Error)) {
      console.warn('[unhandledrejection without Error object]', evt.reason);
    }
  });
})();`,
          }}
        />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
