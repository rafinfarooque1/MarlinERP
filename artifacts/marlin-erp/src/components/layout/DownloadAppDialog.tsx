import { useEffect, useState } from 'react';
import { Apple, Play, Smartphone, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useGetCompanySettings } from '@workspace/api-client-react';

/**
 * "Download Mobile App" modal, opened from the top-right profile menu.
 *
 * Store links come from company settings (Settings → Mobile App) — never
 * hardcoded. An unconfigured store shows an honest "Coming soon" chip instead
 * of a dead button, and when nothing at all is configured the modal says the
 * app is not published yet rather than pretending.
 *
 * The QR encodes GET /api/public/app — a public server redirect that reads the
 * same settings and sends iPhones to the App Store, Androids to Google Play,
 * and anything else to the fallback page / a both-options page. Encoding the
 * redirect (not a store URL) means printed or screenshotted QRs keep working
 * when the links change later.
 */
export function DownloadAppDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: settings } = useGetCompanySettings();
  const gs = (settings as any)?.generalSettings ?? {};
  const cleanUrl = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return /^https?:\/\//i.test(t) ? t : null;
  };
  const iosUrl = cleanUrl(gs.mobileAppIosUrl);
  const androidUrl = cleanUrl(gs.mobileAppAndroidUrl);
  const fallbackUrl = cleanUrl(gs.mobileAppFallbackUrl);
  // The QR is only useful when scanning it leads somewhere real.
  const hasDestination = !!(iosUrl || androidUrl || fallbackUrl);

  const [qrUrl, setQrUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !hasDestination) { setQrUrl(null); return; }
    let cancelled = false;
    const target = `${window.location.origin}/api/public/app`;
    (import('qrcode') as Promise<any>)
      .then(QR => QR.toDataURL(target, { width: 176, margin: 2 }))
      .then((url: string) => { if (!cancelled) setQrUrl(url); })
      .catch(() => { if (!cancelled) setQrUrl(null); });
    return () => { cancelled = true; };
  }, [open, hasDestination]);

  const companyName = (settings as any)?.companyName || 'Marlin Frozen Fruits';
  const logoUrl = (settings as any)?.logoUrl as string | null | undefined;

  const StoreButton = ({ href, icon: Icon, topLine, storeName }: {
    href: string | null;
    icon: React.ElementType;
    topLine: string;
    storeName: string;
  }) => href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-xl bg-foreground text-background px-4 py-2.5 hover:opacity-90 transition-opacity"
    >
      <Icon className="w-6 h-6 shrink-0" />
      <span className="flex flex-col items-start leading-tight">
        <span className="text-[10px] opacity-80">{topLine}</span>
        <span className="text-sm font-semibold">{storeName}</span>
      </span>
    </a>
  ) : (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-2.5 text-muted-foreground select-none">
      <Icon className="w-6 h-6 shrink-0 opacity-50" />
      <span className="flex flex-col items-start leading-tight">
        <span className="text-[10px]">{storeName}</span>
        <span className="text-sm font-semibold">Coming soon</span>
      </span>
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
              <DialogTitle>{companyName} Mobile App</DialogTitle>
              <DialogDescription>Manage your business from anywhere</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <StoreButton href={iosUrl} icon={Apple} topLine="Download on the" storeName="App Store" />
          <StoreButton href={androidUrl} icon={Play} topLine="Get it on" storeName="Google Play" />
        </div>

        {hasDestination ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/30 p-4">
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <QrCode className="w-4 h-4" /> Scan to Download
            </p>
            {qrUrl ? (
              <img src={qrUrl} alt="QR code to download the mobile app" className="w-44 h-44 rounded-lg bg-white p-1" />
            ) : (
              <div className="w-44 h-44 rounded-lg bg-muted animate-pulse" />
            )}
            <p className="text-xs text-muted-foreground text-center">
              {(iosUrl || androidUrl)
                ? 'Point your phone camera at the code — it opens the right store for your device.'
                : 'Point your phone camera at the code — it opens the download page.'}
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
            The mobile app hasn't been published to the app stores yet. Once it's live, add the
            store links under Settings → Mobile App and they'll appear here automatically.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
