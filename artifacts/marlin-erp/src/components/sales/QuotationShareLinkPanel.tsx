/**
 * Share-link management for one quotation.
 *
 * Mirror of InvoiceShareLinkPanel with the quotation endpoints behind it: a
 * link is live state — active or not, when it dies, how often it was opened —
 * and it can be revoked. The WhatsApp send is delegated upward because the
 * message is composed from the quotation the caller already holds.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useQuotationShareLink, getQuotationShareLinkQueryKey,
  ensureQuotationShareLink, regenerateQuotationShareLink, revokeQuotationShareLink,
  absoluteShareUrl,
  type InvoiceShareLink,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { WhatsAppIcon } from '@/components/ui/WhatsAppIcon';
import { toast } from 'sonner';
import { Link2, Copy, RefreshCw, Ban, Loader2 } from 'lucide-react';
import { NO_PHONE_MESSAGE } from './InvoiceShareLinkPanel';

interface Props {
  quotationId: number;
  /** Whether this user may release quotations outside the company. */
  canShare: boolean;
  /** Sends the quotation, given a ready-to-use public URL. */
  onShareWhatsApp: () => void | Promise<void>;
  customerPhone?: string | null;
}

const dateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—';

const dateOnly = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function StatusBadge({ link }: { link: InvoiceShareLink | null }) {
  if (!link) return <Badge variant="outline" className="text-muted-foreground">Not shared yet</Badge>;
  if (link.status === 'active') {
    return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15">Active</Badge>;
  }
  if (link.status === 'expired') {
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 hover:bg-amber-500/15">Expired</Badge>;
  }
  return <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15">Revoked</Badge>;
}

export function QuotationShareLinkPanel({ quotationId, canShare, onShareWhatsApp, customerPhone }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuotationShareLink(quotationId, { query: { enabled: canShare } });
  const [busy, setBusy] = useState<null | 'copy' | 'regenerate' | 'revoke' | 'whatsapp'>(null);
  const [shown, setShown] = useState<string | null>(null);

  if (!canShare) return null;

  const link = data?.link ?? null;
  const isActive = link?.status === 'active';
  const phone = customerPhone ?? data?.customerPhone ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: getQuotationShareLinkQueryKey(quotationId) });

  const handleCopy = async () => {
    setBusy('copy');
    try {
      const { link: fresh, reused } = isActive
        ? { link: link!, reused: true }
        : await ensureQuotationShareLink(quotationId, 'link');
      if (!fresh?.path) throw new Error('no link');
      const ok = await copyToClipboard(absoluteShareUrl(fresh.path));
      if (!reused) await refresh();
      toast[ok ? 'success' : 'error'](
        ok
          ? reused ? 'Quotation link copied' : 'New quotation link created and copied'
          : 'Could not copy automatically — the link is open in the box below.',
      );
      if (!ok) setShown(absoluteShareUrl(fresh.path));
    } catch {
      toast.error('Could not prepare the quotation link. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const handleRegenerate = async () => {
    setBusy('regenerate');
    try {
      const { link: fresh } = await regenerateQuotationShareLink(quotationId);
      await refresh();
      if (fresh.path) {
        const ok = await copyToClipboard(absoluteShareUrl(fresh.path));
        if (!ok) setShown(absoluteShareUrl(fresh.path));
        toast.success(ok
          ? 'New link created and copied. The previous link no longer works.'
          : 'New link created. The previous link no longer works.');
      }
    } catch {
      toast.error('Could not create a new link. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async () => {
    setBusy('revoke');
    try {
      await revokeQuotationShareLink(quotationId);
      await refresh();
      setShown(null);
      toast.success('Link revoked. Anyone holding it can no longer open the quotation.');
    } catch {
      toast.error('Could not revoke the link. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const handleWhatsApp = async () => {
    setBusy('whatsapp');
    try {
      await onShareWhatsApp();
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-muted-foreground" />
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Customer quotation link</p>
        </div>
        {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" /> : <StatusBadge link={link} />}
      </div>

      {link ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">{link.status === 'active' ? 'Valid until' : 'Expiry date'}</dt>
          <dd className="text-right font-medium">{dateOnly(link.expiresAt)}</dd>
          <dt className="text-muted-foreground">Times opened</dt>
          <dd className="text-right font-medium font-mono">{link.accessCount}</dd>
          <dt className="text-muted-foreground">Last opened</dt>
          <dd className="text-right font-medium">{dateTime(link.lastAccessAt)}</dd>
          {link.revokedAt && (
            <>
              <dt className="text-muted-foreground">Revoked on</dt>
              <dd className="text-right font-medium">{dateTime(link.revokedAt)}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">
          No link has been created for this quotation yet. A link stays valid for 15 days
          and can be revoked at any time.
        </p>
      )}

      {link && link.status !== 'active' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {link.status === 'expired'
            ? 'This link has expired. Sharing again will create a fresh one.'
            : 'This link was revoked. Sharing again will create a fresh one.'}
        </p>
      )}

      {shown && (
        <input
          readOnly
          value={shown}
          onFocus={e => e.currentTarget.select()}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="gap-1.5 bg-[#25D366] hover:bg-[#128C7E] text-white border-0"
          disabled={!phone || busy !== null}
          title={phone ? `Send quotation to ${phone} via WhatsApp` : NO_PHONE_MESSAGE}
          onClick={() => void handleWhatsApp()}
        >
          {busy === 'whatsapp' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <WhatsAppIcon className="w-3.5 h-3.5" />}
          Share on WhatsApp
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} onClick={() => void handleCopy()}>
          {busy === 'copy' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
          Copy link
        </Button>
        {link && (
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} onClick={() => void handleRegenerate()}>
            {busy === 'regenerate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            New link
          </Button>
        )}
        {isActive && (
          <Button
            size="sm" variant="outline"
            className="gap-1.5 border-red-500/40 text-red-600 hover:bg-red-500/10 hover:text-red-700"
            disabled={busy !== null}
            onClick={() => void handleRevoke()}
          >
            {busy === 'revoke' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
            Revoke
          </Button>
        )}
      </div>

      {!phone && <p className="text-xs text-amber-600 dark:text-amber-400">{NO_PHONE_MESSAGE}</p>}
    </div>
  );
}
