import { useEffect, useState } from 'react';
import { Apple, Download, Smartphone } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useGetCompanySettings } from '@workspace/api-client-react';

/**
 * "Download Mobile App" modal, opened from the top-right profile menu.
 *
 * The app is deliberately NOT on Google Play / the App Store, so the modal
 * never shows store badges. Distribution (all configured under Settings →
 * Mobile App, never hardcoded):
 *   Android — [Download APK] hits GET /api/public/app/apk, a server proxy of
 *     the configured APK URL that serves the file with a clean versioned
 *     filename. Unconfigured → an honest "not currently available" note.
 *   iOS — [Install iOS App] opens the configured Apple-supported install link
 *     (TestFlight / OTA manifest / a real listing later). A plain .ipa
 *     download is never offered — iPhones cannot install one from a browser.
 *
 * Device-aware: on an Android phone the Android card leads and the iOS card
 * follows (and vice versa); QR codes are desktop-only, since a phone viewing
 * the modal can just tap its own button. Each QR encodes its platform's REAL
 * destination — Android's the stable server download URL, iOS's the
 * configured install link directly (Apple install schemes must be opened by
 * the phone itself, not proxied).
 */
export function DownloadAppDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: settings } = useGetCompanySettings();
  const gs = (settings as any)?.generalSettings ?? {};
  const cleanUrl = (v: unknown, ios = false): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t) return null;
    // iOS mirrors the server rule: Apple-supported install links only — never
    // a raw .ipa file (iPhones cannot install one from a browser, so showing
    // an Install button for it would be a fake).
    if (ios && /\.ipa(\?|#|$)/i.test(t)) return null;
    if (/^https?:\/\//i.test(t)) return t;
    if (ios && /^itms-services:/i.test(t)) return t;
    return null;
  };
  const cleanText = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  // Android is available when an APK file has been uploaded into the system
  // (preferred), or — advanced fallback — an external APK link is set. Either
  // way the button hits our own download endpoint, which picks the source.
  const apkUploaded =
    typeof gs.androidApkObjectPath === 'string' && gs.androidApkObjectPath.startsWith('/objects/');
  const apkConfigured = apkUploaded || !!cleanUrl(gs.androidApkUrl);
  const iosUrl = cleanUrl(gs.iosInstallUrl, true);
  const androidVersion = cleanText(gs.androidAppVersion);
  const iosVersion = cleanText(gs.iosAppVersion);
  // The button downloads via the server so the filename is professional and
  // the hosting location never leaks into bookmarks/QRs.
  const apkDownloadUrl = `${window.location.origin}/api/public/app/apk`;

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroidDevice = /Android/i.test(ua);
  const isIosDevice = /iPhone|iPad|iPod/i.test(ua);
  const isDesktop = !isAndroidDevice && !isIosDevice;

  // Desktop-only QR codes, one per configured platform.
  const [qrAndroid, setQrAndroid] = useState<string | null>(null);
  const [qrIos, setQrIos] = useState<string | null>(null);
  useEffect(() => {
    // Drop any previously generated QR immediately — if the config changed
    // while the dialog is open (e.g. an admin just cleared a link), a stale
    // QR must never keep pointing at the old destination.
    setQrAndroid(null);
    setQrIos(null);
    if (!open || !isDesktop || (!apkConfigured && !iosUrl)) return;
    let cancelled = false;
    (import('qrcode') as Promise<any>).then(QR => {
      if (apkConfigured) {
        QR.toDataURL(apkDownloadUrl, { width: 144, margin: 2 })
          .then((u: string) => { if (!cancelled) setQrAndroid(u); })
          .catch(() => { if (!cancelled) setQrAndroid(null); });
      }
      if (iosUrl) {
        QR.toDataURL(iosUrl, { width: 144, margin: 2 })
          .then((u: string) => { if (!cancelled) setQrIos(u); })
          .catch(() => { if (!cancelled) setQrIos(null); });
      }
    }).catch(() => { /* QR is a convenience, never an error */ });
    return () => { cancelled = true; };
  }, [open, isDesktop, apkConfigured, iosUrl, apkDownloadUrl]);

  const companyName = (settings as any)?.companyName || 'Marlin Frozen Fruits';
  const logoUrl = (settings as any)?.logoUrl as string | null | undefined;

  const AndroidCard = (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${isAndroidDevice ? 'border-primary/50 bg-primary/5' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <Smartphone className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Android</span>
        {androidVersion && <span className="text-xs text-muted-foreground">Version {androidVersion}</span>}
      </div>
      {apkConfigured ? (
        <>
          <a
            href={apkDownloadUrl}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            <Download className="w-4 h-4" /> Download APK
          </a>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Download the Android app directly. Android may ask you to allow installation from this source.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Android app download is not currently available.</p>
      )}
    </div>
  );

  const IosCard = (
    <div className={`rounded-xl border p-4 flex flex-col gap-2 ${isIosDevice ? 'border-primary/50 bg-primary/5' : 'border-border'}`}>
      <div className="flex items-center gap-2">
        <Apple className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">iPhone / iOS</span>
        {iosVersion && <span className="text-xs text-muted-foreground">Version {iosVersion}</span>}
      </div>
      {iosUrl ? (
        <a
          href={iosUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-foreground text-background px-4 py-2 text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          <Apple className="w-4 h-4" /> Install iOS App
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">iOS installation is not currently configured.</p>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="w-11 h-11 rounded-xl object-contain border border-border bg-background" />
            ) : (
              <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
                <Smartphone className="w-6 h-6 text-primary" />
              </div>
            )}
            <div className="text-left">
              <DialogTitle>Download Mobile App</DialogTitle>
              <DialogDescription>Access your {companyName} ERP from your phone</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* The visitor's own platform leads. */}
        <div className="flex flex-col gap-2.5">
          {isIosDevice ? <>{IosCard}{AndroidCard}</> : <>{AndroidCard}{IosCard}</>}
        </div>

        {isDesktop && (qrAndroid || qrIos) && (
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-start justify-center gap-6">
              {qrAndroid && (
                <div className="flex flex-col items-center gap-1.5">
                  <img src={qrAndroid} alt="QR code to download the Android APK" className="w-36 h-36 rounded-lg bg-white p-1" />
                  <p className="text-[11px] text-muted-foreground text-center">Scan to download Android APK</p>
                </div>
              )}
              {qrIos && (
                <div className="flex flex-col items-center gap-1.5">
                  <img src={qrIos} alt="QR code to install the iOS app" className="w-36 h-36 rounded-lg bg-white p-1" />
                  <p className="text-[11px] text-muted-foreground text-center">Scan to install iOS app</p>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
