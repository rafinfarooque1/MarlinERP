import { Platform } from 'react-native';
import { customFetch } from '@workspace/api-client-react';

/**
 * Money-voucher PDF: the server renders every business PDF from the stored
 * row under the location letterhead (POST /pdf/money-voucher, bearer-gated,
 * bytes back). There is no tokenized public URL for vouchers, so the client
 * fetches the bytes itself:
 *   · web    — blob → object URL into a tab opened INSIDE the tap gesture
 *              (popup blockers eat windows opened from a later promise tick)
 *   · native — blob → base64 → cache file → OS share sheet
 */

export type MoneyVoucherKind = 'receipt' | 'payment';

const fetchVoucherPdfBlob = (kind: MoneyVoucherKind, id: number): Promise<Blob> =>
  customFetch<Blob>('/api/pdf/money-voucher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, id }),
    responseType: 'blob',
  });

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the PDF data.'));
    reader.onloadend = () => {
      const s = String(reader.result ?? '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.readAsDataURL(blob);
  });
}

/** Open (web) or share (native) one voucher's PDF. Throws on failure — the
 * caller surfaces the message; server errors carry `e.data.error`. */
export async function openMoneyVoucherPdf(
  kind: MoneyVoucherKind,
  id: number,
  voucherNumber?: string | null,
): Promise<void> {
  const safeName = (voucherNumber || `${kind}-${id}`).replace(/[^A-Za-z0-9._-]+/g, '_');
  const fileName = `Voucher-${safeName}.pdf`;

  if (Platform.OS === 'web') {
    const win = window.open('', '_blank');
    try {
      const blob = await fetchVoucherPdfBlob(kind, id);
      const url = URL.createObjectURL(blob);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
    } catch (e) {
      win?.close();
      throw e;
    }
    return;
  }

  const blob = await fetchVoucherPdfBlob(kind, id);
  const base64 = await blobToBase64(blob);
  const FileSystem = await import('expo-file-system/legacy');
  const Sharing = await import('expo-sharing');
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, { mimeType: 'application/pdf', dialogTitle: fileName });
}
