import { Platform, type View } from 'react-native';
import { notify } from '@/lib/dialogs';

/**
 * Capture a rendered View as a PNG and hand it to the platform's share
 * surface. Mirrors the web ERP dashboard's Share-as-image feature.
 *
 * - iOS/Android: react-native-view-shot renders the view to a temp file and
 *   expo-sharing opens the native share sheet (WhatsApp, mail, save…).
 * - Web: react-native-web forwards the View ref to its DOM element, so
 *   html-to-image rasterises it (html2canvas is avoided on purpose — see the
 *   web dashboard: it cannot parse modern CSS colors). The image goes to the
 *   Web Share API where files are supported, otherwise it downloads.
 *
 * Failure is loud (alert), never silent; a dismissed share sheet is not an
 * error. Both capture libraries are imported lazily so the Home screen does
 * not pay for them until the button is pressed.
 */
export async function shareViewAsImage(
  target: View | null,
  opts: { fileName: string; backgroundColor: string; dialogTitle: string },
): Promise<void> {
  if (!target) return;
  try {
    if (Platform.OS === 'web') {
      // On react-native-web the host ref IS the DOM element.
      const node = target as unknown as HTMLElement;
      if (typeof node.getBoundingClientRect !== 'function') {
        throw new Error('Could not find the dashboard on screen.');
      }
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(node, {
        backgroundColor: opts.backgroundColor,
        pixelRatio: 2,
        // Padding so the image doesn't sit flush against its edges.
        style: { padding: '12px' },
        width: node.offsetWidth + 24,
        height: node.offsetHeight + 24,
      });
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], opts.fileName, { type: 'image/png' });
      const nav = navigator as Navigator & {
        canShare?: (data: { files: File[] }) => boolean;
        share?: (data: { files: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({ files: [file], title: opts.dialogTitle });
        } catch (err) {
          // A dismissed share sheet is a user choice, not a failure.
          if ((err as Error)?.name !== 'AbortError') throw err;
        }
      } else {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = opts.fileName;
        a.click();
      }
      return;
    }

    const [{ captureRef, releaseCapture }, Sharing] = await Promise.all([
      import('react-native-view-shot'),
      import('expo-sharing'),
    ]);
    const uri = await captureRef(target, {
      format: 'png',
      quality: 1,
      result: 'tmpfile',
    });
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/png',
          dialogTitle: opts.dialogTitle,
          UTI: 'public.png',
        });
      } else {
        notify('Sharing unavailable', 'This device does not offer a share sheet.');
      }
    } finally {
      // The capture is a real temp file — without this, repeated shares
      // accumulate PNGs in temp storage for the whole session.
      releaseCapture(uri);
    }
  } catch (err) {
    console.error('share dashboard failed', err);
    notify('Could not share', 'Something went wrong while preparing the image. Please try again.');
  }
}
