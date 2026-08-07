import { Alert, Platform } from 'react-native';

/**
 * Cross-platform dialogs. React Native Web's Alert.alert is a NO-OP — on the
 * web build every confirm silently did nothing and every error message was
 * invisible. Fall back to the browser's native dialogs there; use Alert on
 * iOS/Android as before.
 */

export function confirmDialog(opts: {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  destructive?: boolean;
  onConfirm: () => void;
}): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${opts.title}\n\n${opts.message}`)) {
      opts.onConfirm();
    }
    return;
  }
  Alert.alert(opts.title, opts.message, [
    { text: opts.cancelText, style: 'cancel' },
    {
      text: opts.confirmText,
      style: opts.destructive ? 'destructive' : 'default',
      onPress: opts.onConfirm,
    },
  ]);
}

export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
