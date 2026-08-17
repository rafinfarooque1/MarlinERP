import React, { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import {
  ensureInvoiceShareLink,
  invoicePdfPath,
  mintInvoicePdfToken,
  useSaleDetail,
  type SaleDetailLine,
} from '@workspace/api-client-react';
import { FormScreen } from '@/components/ui/FormScreen';
import { StatusBadge, type BadgeTone } from '@/components/ui/StatusBadge';
import { formatMoney } from '@/components/ui/MoneyText';
import { apiOrigin } from '@/lib/apiOrigin';
import { notify } from '@/lib/dialogs';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { useColors } from '@/hooks/useColors';

function statusMeta(status?: string, cancelled?: boolean): { label: string; tone: BadgeTone } {
  if (cancelled || status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (status === 'paid') return { label: 'Paid', tone: 'success' };
  if (status === 'partially_paid') return { label: 'Partially paid', tone: 'warning' };
  return { label: 'Unpaid', tone: 'destructive' };
}

/** Legacy card/bank_transfer read as Bank — never rewritten (payment-modes). */
function paymentModeLabel(mode?: string): string {
  switch ((mode ?? '').toLowerCase()) {
    case 'cash': return 'Cash';
    case 'upi': return 'UPI';
    case 'credit': return 'Credit';
    case 'bank':
    case 'card':
    case 'bank_transfer': return 'Bank';
    default: return mode || '—';
  }
}

function formatDate(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Line discount for display: per-unit ₹ × qty on newer rows, the stored
 * line-total ₹ on legacy rows — never both, never recomputed from prices. */
function lineDiscountText(li: SaleDetailLine): string | null {
  const perUnit = Number(li.unitDiscount ?? 0);
  if (perUnit > 0) {
    const qty = Number(li.quantity ?? 0);
    return `− ${formatMoney(Math.round(perUnit * qty * 100) / 100, { showPaise: true })} discount`;
  }
  const legacy = Number(li.discount ?? 0);
  if (legacy > 0) return `− ${formatMoney(legacy, { showPaise: true })} discount`;
  return null;
}

export default function SaleDetailScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ id: string }>();
  const saleId = Number(params.id) || null;
  const { data: sale, isLoading, error } = useSaleDetail(saleId);
  const { ready, perm } = useErpPermissions();
  const canDownload = ready && perm(PAGE.sales).canDownload;

  const [pdfBusy, setPdfBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);

  const styles = makeStyles(colors);

  const openPdf = async () => {
    if (!saleId || pdfBusy) return;
    setPdfBusy(true);
    try {
      if (Platform.OS === 'web') {
        // Open the tab inside the click gesture — popup blockers eat windows
        // opened from a later promise tick.
        const win = window.open('', '_blank');
        try {
          const { token } = await mintInvoicePdfToken(saleId);
          const url = `${apiOrigin()}${invoicePdfPath(token)}`;
          if (win) win.location.href = url;
          else window.open(url, '_blank');
        } catch (e) {
          win?.close();
          throw e;
        }
      } else {
        const { token } = await mintInvoicePdfToken(saleId);
        await Linking.openURL(`${apiOrigin()}${invoicePdfPath(token)}`);
      }
    } catch (e: any) {
      notify('Could not open PDF', e?.data?.error || e?.message || 'Please try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const shareInvoice = async () => {
    if (!saleId || shareBusy) return;
    setShareBusy(true);
    try {
      // Revocable customer-facing link (not the 30-minute internal token).
      const result = await ensureInvoiceShareLink(saleId, 'link');
      const path = result.link?.path;
      if (!path) throw new Error('No active share link.');
      const url = `${apiOrigin()}${path}`;
      const message = `Invoice ${sale?.invoiceNumber ?? ''} — ${url}`;
      if (Platform.OS === 'web') {
        const nav: any = typeof navigator !== 'undefined' ? navigator : null;
        if (nav?.share) await nav.share({ title: `Invoice ${sale?.invoiceNumber ?? ''}`, url });
        else if (nav?.clipboard) {
          await nav.clipboard.writeText(url);
          notify('Link copied', 'The invoice link is on your clipboard.');
        } else notify('Invoice link', url);
      } else {
        await Share.share({ message });
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // user dismissed the share sheet
      notify('Could not share invoice', e?.data?.error || e?.message || 'Please try again.');
    } finally {
      setShareBusy(false);
    }
  };

  if (isLoading || !ready) {
    return (
      <FormScreen title="Sale">
        <ActivityIndicator color={colors.primary} style={{ marginTop: 48 }} />
      </FormScreen>
    );
  }

  if (error || !sale) {
    return (
      <FormScreen title="Sale">
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {(error as any)?.data?.error || 'This sale could not be loaded.'}
          </Text>
        </View>
      </FormScreen>
    );
  }

  const badge = statusMeta(sale.paymentStatus, sale.isCancelled);
  const lines = Array.isArray(sale.lineItems) ? sale.lineItems : [];

  return (
    <FormScreen
      title={sale.invoiceNumber || `Sale #${sale.id}`}
      subtitle={formatDate(sale.saleDate)}
      footer={
        canDownload ? (
          <View style={styles.footerRow}>
            <Pressable
              onPress={openPdf}
              disabled={pdfBusy}
              style={({ pressed }) => [styles.footerBtn, styles.footerBtnOutline, (pressed || pdfBusy) && { opacity: 0.7 }]}
            >
              {pdfBusy ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Feather name="file-text" size={16} color={colors.primary} />
              )}
              <Text style={[styles.footerBtnText, { color: colors.primary }]}>View PDF</Text>
            </Pressable>
            <Pressable
              onPress={shareInvoice}
              disabled={shareBusy}
              style={({ pressed }) => [styles.footerBtn, { backgroundColor: colors.primary }, (pressed || shareBusy) && { opacity: 0.7 }]}
            >
              {shareBusy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="share-2" size={16} color={colors.primaryForeground} />
              )}
              <Text style={[styles.footerBtnText, { color: colors.primaryForeground }]}>Share invoice</Text>
            </Pressable>
          </View>
        ) : undefined
      }
    >
      {/* ── Overview ── */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <StatusBadge label={badge.label} tone={badge.tone} />
          <Text style={styles.metaText}>{paymentModeLabel(sale.paymentMode)}</Text>
        </View>
        <View style={{ gap: 6, marginTop: 12 }}>
          <InfoRow label="Customer" value={sale.customerName || 'Walk-in customer'} styles={styles} />
          {sale.outletName ? <InfoRow label="Location" value={sale.outletName} styles={styles} /> : null}
          {sale.quotationNumber ? (
            <InfoRow label="From quotation" value={sale.quotationNumber} styles={styles} />
          ) : null}
        </View>
      </View>

      {/* ── Items ── */}
      <Text style={styles.sectionTitle}>Items</Text>
      <View style={styles.card}>
        {lines.length === 0 ? (
          <Text style={styles.emptyText}>No line items on this sale.</Text>
        ) : (
          lines.map((li, i) => {
            const disc = lineDiscountText(li);
            return (
              <View key={i} style={[styles.lineRow, i > 0 && styles.lineRowBorder]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.lineName} numberOfLines={2}>
                    {li.itemName || `Item #${li.itemId}`}
                  </Text>
                  <Text style={styles.metaText}>
                    {Number(li.quantity ?? 0)}{li.unit ? ` ${li.unit}` : ''} × {formatMoney(Number(li.unitPrice ?? 0), { showPaise: true })}
                  </Text>
                  {disc ? <Text style={[styles.metaText, { color: colors.warning }]}>{disc}</Text> : null}
                </View>
                {Number(li.taxAmount ?? 0) > 0 ? (
                  <Text style={styles.metaText}>
                    GST {formatMoney(Number(li.taxAmount), { showPaise: true })}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}
      </View>

      {/* ── Totals ── */}
      <Text style={styles.sectionTitle}>Totals</Text>
      <View style={styles.card}>
        <TotalRow label="Taxable value" value={sale.subtotal} styles={styles} />
        <TotalRow label="GST" value={sale.taxTotal} styles={styles} />
        {Number(sale.billDiscount ?? 0) > 0 ? (
          <TotalRow label="Bill discount" value={-Number(sale.billDiscount)} styles={styles} />
        ) : null}
        {Number(sale.discountTotal ?? 0) > 0 ? (
          <TotalRow
            label={sale.couponCode ? `Coupon (${sale.couponCode})` : 'Coupon discount'}
            value={-Number(sale.discountTotal)}
            styles={styles}
          />
        ) : null}
        {(sale.otherCharges ?? []).map((c, i) => (
          <TotalRow key={i} label={c.ledgerName || 'Other charge'} value={Number(c.amount ?? 0)} styles={styles} />
        ))}
        <View style={styles.divider} />
        <TotalRow label="Invoice total" value={sale.totalAmount} bold styles={styles} />
        {Number(sale.creditAdjustments ?? 0) > 0 ? (
          <TotalRow label="Credit notes" value={-Number(sale.creditAdjustments)} styles={styles} />
        ) : null}
        <TotalRow label="Received" value={sale.amountReceived} styles={styles} />
        <TotalRow
          label="Balance due"
          value={sale.balanceDue}
          bold
          color={Number(sale.balanceDue ?? 0) > 0 ? colors.destructive : colors.success}
          styles={styles}
        />
      </View>
    </FormScreen>
  );
}

function InfoRow({ label, value, styles }: { label: string; value: string; styles: any }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.metaText}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function TotalRow({
  label, value, bold, color, styles,
}: { label: string; value: number; bold?: boolean; color?: string; styles: any }) {
  return (
    <View style={styles.rowBetween}>
      <Text style={[styles.metaText, bold && styles.totalBoldLabel]}>{label}</Text>
      <Text style={[bold ? styles.totalBoldValue : styles.totalValue, color ? { color } : null]}>
        {formatMoney(Number(value ?? 0), { showPaise: true })}
      </Text>
    </View>
  );
}

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 8,
    },
    sectionTitle: {
      fontSize: 13,
      fontFamily: 'Outfit_600SemiBold',
      color: colors.mutedForeground,
      marginTop: 16,
      marginBottom: 8,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    rowBetween: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    metaText: { fontSize: 13, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
    infoValue: {
      fontSize: 14,
      fontFamily: 'Outfit_500Medium',
      color: colors.foreground,
      flexShrink: 1,
    },
    lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
    lineRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    lineName: { fontSize: 14, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
    totalValue: { fontSize: 14, fontFamily: 'Outfit_500Medium', color: colors.foreground },
    totalBoldLabel: { fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    totalBoldValue: { fontSize: 16, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    footerRow: { flexDirection: 'row', gap: 10 },
    footerBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      borderRadius: 12,
      paddingVertical: 13,
    },
    footerBtnOutline: { borderWidth: 1, borderColor: colors.primary },
    footerBtnText: { fontSize: 14, fontFamily: 'Outfit_600SemiBold' },
    emptyText: { fontSize: 13, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground },
  });
