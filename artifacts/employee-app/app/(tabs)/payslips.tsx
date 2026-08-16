import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { notify } from '@/lib/dialogs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListEnrichedPayroll, EnrichedPayrollRecord } from '@workspace/api-client-react';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function generatePayslipHTML(record: EnrichedPayrollRecord, employeeName: string, branchName: string): string {
  const month = MONTHS[record.month - 1];
  const allowancesRows = record.allowancesBreakdown.map((a) =>
    `<tr><td>${a.name}</td><td style="text-align:right">₹${a.amount.toLocaleString('en-IN')}</td></tr>`
  ).join('');
  const deductionsRows = record.deductionsBreakdown.map((d) =>
    `<tr><td>${d.name}</td><td style="text-align:right">₹${d.amount.toLocaleString('en-IN')}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"/>
<style>
  body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #0a1120; }
  .header { background: #0d89a5; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0; }
  .header h1 { margin: 0; font-size: 20px; }
  .header p  { margin: 4px 0 0; font-size: 13px; opacity: 0.85; }
  .body { border: 1px solid #d3d8e8; border-top: none; border-radius: 0 0 8px 8px; padding: 20px 24px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
  .info-item label { font-size: 11px; color: #596b85; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-item p { margin: 2px 0 0; font-size: 14px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #f4f6f8; padding: 8px 12px; text-align: left; font-size: 12px; color: #596b85; }
  td { padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #eceef5; }
  .section-title { font-size: 13px; font-weight: 700; color: #0a1120; margin: 16px 0 8px; }
  .net-pay { background: #f0fafa; border: 2px solid #0d89a5; border-radius: 8px; padding: 16px 20px; text-align: right; }
  .net-pay .label { font-size: 13px; color: #596b85; }
  .net-pay .amount { font-size: 28px; font-weight: 700; color: #0d89a5; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .status-paid { background: #dcfce7; color: #16a34a; }
  .status-approved { background: #e0f7fa; color: #0d89a5; }
  .status-draft { background: #fef3c7; color: #d97706; }
  .footer { margin-top: 24px; font-size: 11px; color: #596b85; text-align: center; }
</style></head><body>
<div class="header">
  <h1>Salary Slip</h1>
  <p>${month} ${record.year}</p>
</div>
<div class="body">
  <div class="info-grid">
    <div class="info-item"><label>Employee Name</label><p>${employeeName}</p></div>
    <div class="info-item"><label>Branch</label><p>${branchName}</p></div>
    <div class="info-item"><label>Month</label><p>${month} ${record.year}</p></div>
    <div class="info-item"><label>Status</label><p><span class="status-badge status-${record.status}">${record.status.charAt(0).toUpperCase() + record.status.slice(1)}</span></p></div>
    <div class="info-item"><label>Working Days</label><p>${record.workingDays}</p></div>
    <div class="info-item"><label>Present Days</label><p>${record.presentDays}${record.lopDays > 0 ? ` (${record.lopDays} LOP)` : ''}</p></div>
  </div>

  <div class="section-title">Earnings</div>
  <table>
    <tr><th>Component</th><th style="text-align:right">Amount</th></tr>
    <tr><td>Basic Salary</td><td style="text-align:right">₹${record.baseSalary.toLocaleString('en-IN')}</td></tr>
    ${allowancesRows}
    ${record.lopDeduction > 0 ? `<tr><td style="color:#ef2424">LOP Deduction</td><td style="text-align:right;color:#ef2424">−₹${record.lopDeduction.toLocaleString('en-IN')}</td></tr>` : ''}
    <tr style="font-weight:600"><td>Gross Pay</td><td style="text-align:right">₹${record.grossPay.toLocaleString('en-IN')}</td></tr>
  </table>

  <div class="section-title">Deductions</div>
  <table>
    <tr><th>Component</th><th style="text-align:right">Amount</th></tr>
    ${deductionsRows || '<tr><td colspan="2" style="text-align:center;color:#596b85">No deductions</td></tr>'}
    ${record.advanceDeduction > 0 ? `<tr><td>Advance Recovery</td><td style="text-align:right">₹${record.advanceDeduction.toLocaleString('en-IN')}</td></tr>` : ''}
    <tr style="font-weight:600"><td>Total Deductions</td><td style="text-align:right">₹${record.deductions.toLocaleString('en-IN')}</td></tr>
  </table>

  <div class="net-pay">
    <div class="label">Net Take-Home Pay</div>
    <div class="amount">₹${record.netPay.toLocaleString('en-IN', { minimumFractionDigits: 0 })}</div>
  </div>

  <div class="footer">
    This is a computer-generated payslip. No signature required.<br/>
    Generated on ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
  </div>
</div>
</body></html>`;
}

function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const cfg: Record<string, { bg: string; text: string; label: string }> = {
    paid:     { bg: colors.success + '20', text: colors.success, label: 'Paid' },
    approved: { bg: colors.primary + '20', text: colors.primary, label: 'Approved' },
    draft:    { bg: colors.warning + '20', text: colors.warning, label: 'Draft' },
  };
  const c = cfg[status] ?? cfg.draft;
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
      <Text style={{ fontSize: 11, fontWeight: '600' as const, color: c.text, fontFamily: 'Outfit_600SemiBold' }}>
        {c.label}
      </Text>
    </View>
  );
}

interface DetailModalProps {
  record: EnrichedPayrollRecord | null;
  visible: boolean;
  onClose: () => void;
  employeeName: string;
  branchName: string;
}

function DetailModal({ record, visible, onClose, employeeName, branchName }: DetailModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [downloading, setDownloading] = useState(false);

  if (!record) return null;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const html = generatePayslipHTML(record, employeeName, branchName);

      if (Platform.OS === 'web') {
        const win = window.open('', '_blank');
        if (win) {
          win.document.write(html);
          win.document.close();
          setTimeout(() => win.print(), 500);
        }
        return;
      }

      // Native: use expo-print + expo-sharing dynamically
      try {
        const Print = await import('expo-print');
        const Sharing = await import('expo-sharing');
        const { uri } = await Print.printToFileAsync({ html, base64: false });
        const isAvailable = await Sharing.isAvailableAsync();
        if (isAvailable) {
          await Sharing.shareAsync(uri, {
            mimeType: 'application/pdf',
            dialogTitle: `Payslip ${MONTHS[record.month - 1]} ${record.year}`,
            UTI: 'com.adobe.pdf',
          });
        } else {
          notify('Download', 'Sharing is not available on this device.');
        }
      } catch (e: any) {
        // expo-print not installed - show message
        notify('Not Available', 'PDF download requires the native app. Please use the web version.');
      }
    } catch (e: any) {
      notify('Error', e?.message ?? 'Could not generate PDF');
    } finally {
      setDownloading(false);
    }
  };

  const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: '92%',
      paddingBottom: insets.bottom + 20,
    },
    handle: {
      width: 40, height: 4, borderRadius: 2,
      backgroundColor: colors.border,
      alignSelf: 'center',
      marginTop: 12, marginBottom: 8,
    },
    sheetHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    sheetTitle: {
      fontSize: 18, fontWeight: '700' as const,
      color: colors.foreground, fontFamily: 'Outfit_700Bold',
    },
    sheetSub: {
      fontSize: 13, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', marginTop: 1,
    },
    scrollContent: { padding: 20 },
    netPayCard: {
      backgroundColor: colors.primary + '10',
      borderRadius: 14,
      padding: 20,
      alignItems: 'center',
      marginBottom: 20,
      borderWidth: 1.5,
      borderColor: colors.primary + '30',
    },
    netPayLabel: {
      fontSize: 13, color: colors.primary, fontFamily: 'Outfit_400Regular', marginBottom: 4,
    },
    netPayAmount: {
      fontSize: 40, fontWeight: '700' as const,
      color: colors.primary, fontFamily: 'Outfit_700Bold', letterSpacing: -1,
    },
    netPaySub: {
      fontSize: 12, color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular', marginTop: 4,
    },
    table: {
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 16,
      overflow: 'hidden',
    },
    tableHeader: {
      flexDirection: 'row',
      backgroundColor: colors.muted,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    tableHeaderText: {
      fontSize: 11, fontWeight: '600' as const,
      color: colors.mutedForeground, textTransform: 'uppercase' as const,
      letterSpacing: 0.4, fontFamily: 'Outfit_600SemiBold',
    },
    tableRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 11, paddingHorizontal: 16,
      borderTopWidth: 1, borderTopColor: colors.border,
    },
    tableRowLabel: { fontSize: 14, color: colors.foreground, fontFamily: 'Outfit_400Regular' },
    tableRowValue: { fontSize: 14, fontWeight: '500' as const, color: colors.foreground, fontFamily: 'Outfit_500Medium' },
    tableTotalRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 12, paddingHorizontal: 16,
      borderTopWidth: 2, borderTopColor: colors.border,
      backgroundColor: colors.muted,
    },
    tableTotalLabel: { fontSize: 14, fontWeight: '700' as const, color: colors.foreground, fontFamily: 'Outfit_700Bold' },
    downloadBtn: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      height: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 4,
    },
    downloadBtnDisabled: { opacity: 0.6 },
    downloadBtnText: {
      color: colors.primaryForeground, fontSize: 16,
      fontWeight: '600' as const, fontFamily: 'Outfit_600SemiBold',
    },
    sectionTitle: {
      fontSize: 13, fontWeight: '700' as const, color: colors.foreground,
      marginBottom: 8, fontFamily: 'Outfit_700Bold',
    },
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.sheetTitle}>
                {MONTHS[record.month - 1]} {record.year}
              </Text>
              <Text style={styles.sheetSub}>Salary Slip</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <StatusBadge status={record.status} />
              <Pressable onPress={onClose} hitSlop={8}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent} bounces={false}>
            {/* Net pay highlight */}
            <View style={styles.netPayCard}>
              <Text style={styles.netPayLabel}>Net Take-Home Pay</Text>
              <Text style={styles.netPayAmount}>
                ₹{record.netPay.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
              </Text>
              <Text style={styles.netPaySub}>
                {record.presentDays}/{record.workingDays} days · {record.lopDays} LOP
              </Text>
            </View>

            {/* Earnings */}
            <Text style={styles.sectionTitle}>Earnings</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableHeaderText}>Component</Text>
              </View>
              <View style={styles.tableRow}>
                <Text style={styles.tableRowLabel}>Basic Salary</Text>
                <Text style={styles.tableRowValue}>₹{record.baseSalary.toLocaleString('en-IN')}</Text>
              </View>
              {record.allowancesBreakdown.map((a) => (
                <View key={a.name} style={styles.tableRow}>
                  <Text style={styles.tableRowLabel}>{a.name}</Text>
                  <Text style={styles.tableRowValue}>₹{a.amount.toLocaleString('en-IN')}</Text>
                </View>
              ))}
              {record.lopDeduction > 0 && (
                <View style={styles.tableRow}>
                  <Text style={[styles.tableRowLabel, { color: colors.destructive }]}>LOP Deduction</Text>
                  <Text style={[styles.tableRowValue, { color: colors.destructive }]}>
                    −₹{record.lopDeduction.toLocaleString('en-IN')}
                  </Text>
                </View>
              )}
              <View style={styles.tableTotalRow}>
                <Text style={styles.tableTotalLabel}>Gross Pay</Text>
                <Text style={styles.tableTotalLabel}>₹{record.grossPay.toLocaleString('en-IN')}</Text>
              </View>
            </View>

            {/* Deductions */}
            <Text style={styles.sectionTitle}>Deductions</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableHeaderText}>Component</Text>
              </View>
              {record.deductionsBreakdown.length > 0 ? record.deductionsBreakdown.map((d) => (
                <View key={d.name} style={styles.tableRow}>
                  <Text style={styles.tableRowLabel}>{d.name}</Text>
                  <Text style={[styles.tableRowValue, { color: colors.destructive }]}>
                    ₹{d.amount.toLocaleString('en-IN')}
                  </Text>
                </View>
              )) : (
                <View style={styles.tableRow}>
                  <Text style={{ color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', fontSize: 13 }}>
                    No deductions
                  </Text>
                </View>
              )}
              {record.advanceDeduction > 0 && (
                <View style={styles.tableRow}>
                  <Text style={styles.tableRowLabel}>Advance Recovery</Text>
                  <Text style={[styles.tableRowValue, { color: colors.destructive }]}>
                    ₹{record.advanceDeduction.toLocaleString('en-IN')}
                  </Text>
                </View>
              )}
              <View style={styles.tableTotalRow}>
                <Text style={styles.tableTotalLabel}>Total Deductions</Text>
                <Text style={[styles.tableTotalLabel, { color: colors.destructive }]}>
                  ₹{record.deductions.toLocaleString('en-IN')}
                </Text>
              </View>
            </View>

            {/* Download button */}
            <Pressable
              style={({ pressed }) => [
                styles.downloadBtn,
                (pressed || downloading) && styles.downloadBtnDisabled,
              ]}
              onPress={handleDownload}
              disabled={downloading}
            >
              {downloading ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <>
                  <Feather name="download" size={18} color={colors.primaryForeground} />
                  <Text style={styles.downloadBtnText}>Download PDF</Text>
                </>
              )}
            </Pressable>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default function PayslipsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { employee } = useAuth();

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedRecord, setSelectedRecord] = useState<EnrichedPayrollRecord | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const { token } = useAuth();
  const { data: records, isLoading, refetch } = useListEnrichedPayroll(
    { year: selectedYear },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token } as any },
  );

  const yearOptions = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2];

  const styles = makeStyles(colors, insets);

  const openRecord = (rec: EnrichedPayrollRecord) => {
    setSelectedRecord(rec);
    setModalVisible(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const renderItem = ({ item }: { item: EnrichedPayrollRecord }) => (
    <Pressable
      style={({ pressed }) => [styles.listItem, pressed && styles.listItemPressed]}
      onPress={() => openRecord(item)}
    >
      <View style={styles.itemLeft}>
        <View style={styles.monthBadge}>
          <Text style={styles.monthAbbr}>{MONTHS[item.month - 1].substring(0, 3)}</Text>
          <Text style={styles.monthYear}>{item.year}</Text>
        </View>
        <View>
          <Text style={styles.itemTitle}>{MONTHS[item.month - 1]} {item.year}</Text>
          <Text style={styles.itemSub}>
            {item.presentDays}/{item.workingDays} days
            {item.lopDays > 0 ? ` · ${item.lopDays} LOP` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.itemRight}>
        <Text style={styles.itemAmount}>
          ₹{item.netPay.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
        </Text>
        <StatusBadge status={item.status} />
      </View>
    </Pressable>
  );

  return (
    <>
      <View style={styles.root}>
        {/* Year selector */}
        <View style={styles.yearRow}>
          {yearOptions.map((y) => (
            <Pressable
              key={y}
              style={[styles.yearChip, selectedYear === y && styles.yearChipActive]}
              onPress={() => setSelectedYear(y)}
            >
              <Text style={[styles.yearChipText, selectedYear === y && styles.yearChipTextActive]}>
                {y}
              </Text>
            </Pressable>
          ))}
        </View>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            data={records ?? []}
            keyExtractor={(r) => String(r.id)}
            renderItem={renderItem}
            scrollEnabled={!!(records && records.length > 0)}
            refreshControl={
              <RefreshControl refreshing={isLoading} onRefresh={refetch} tintColor={colors.primary} />
            }
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Feather name="file-text" size={40} color={colors.mutedForeground} />
                <Text style={styles.emptyTitle}>No payslips found</Text>
                <Text style={styles.emptySub}>No payroll records for {selectedYear}.</Text>
              </View>
            }
          />
        )}
      </View>

      <DetailModal
        record={selectedRecord}
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        employeeName={employee?.name ?? ''}
        branchName={employee?.branchName ?? ''}
      />
    </>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    yearRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingTop: Platform.OS === 'web' ? insets.top + 67 + 12 : insets.top + 12,
      paddingBottom: 12,
      gap: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.background,
    },
    yearChip: {
      paddingHorizontal: 16, paddingVertical: 7,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.card,
    },
    yearChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    yearChipText: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Outfit_500Medium' },
    yearChipTextActive: { color: colors.primaryForeground, fontWeight: '600' as const },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    listContent: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 100),
      flexGrow: 1,
    },
    listItem: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      marginBottom: 10,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    listItemPressed: { opacity: 0.87 },
    itemLeft: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    monthBadge: {
      width: 48, height: 52,
      backgroundColor: colors.primary + '12',
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.primary + '25',
    },
    monthAbbr: {
      fontSize: 13, fontWeight: '700' as const,
      color: colors.primary, fontFamily: 'Outfit_700Bold',
    },
    monthYear: {
      fontSize: 10, color: colors.primary,
      fontFamily: 'Outfit_400Regular', marginTop: 1,
    },
    itemTitle: {
      fontSize: 15, fontWeight: '600' as const,
      color: colors.foreground, fontFamily: 'Outfit_600SemiBold',
    },
    itemSub: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular', marginTop: 2 },
    itemRight: { alignItems: 'flex-end', gap: 6 },
    itemAmount: {
      fontSize: 16, fontWeight: '700' as const,
      color: colors.foreground, fontFamily: 'Outfit_700Bold',
    },
    emptyContainer: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingTop: 80, gap: 10,
    },
    emptyTitle: {
      fontSize: 18, fontWeight: '600' as const,
      color: colors.foreground, fontFamily: 'Outfit_600SemiBold',
    },
    emptySub: { fontSize: 14, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
  });
}
