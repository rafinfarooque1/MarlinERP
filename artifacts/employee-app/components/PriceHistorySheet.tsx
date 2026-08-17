import React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSalePriceHistory } from '@workspace/api-client-react';
import { formatMoney } from '@/components/ui/MoneyText';
import { useColors } from '@/hooks/useColors';

/**
 * Read-only price history bottom sheet: the last few prices THIS customer
 * actually paid for the item, straight from their past invoices. Purely
 * informational — tapping a row does nothing to the cart.
 */
export function PriceHistorySheet({
  visible,
  onClose,
  customerId,
  itemId,
  itemName,
}: {
  visible: boolean;
  onClose: () => void;
  customerId: number | null;
  itemId: number | null;
  itemName: string;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { data, isLoading } = useSalePriceHistory(
    visible ? customerId : null,
    visible ? itemId : null,
  );
  const styles = makeStyles(colors, insets.bottom);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.title}>Price history</Text>
        <Text style={styles.subtitle} numberOfLines={1}>{itemName}</Text>
        {isLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
        ) : (
          <FlatList
            data={data ?? []}
            keyExtractor={r => `${r.saleId}-${r.invoiceNumber}`}
            style={{ flexGrow: 0 }}
            ListEmptyComponent={
              <Text style={styles.empty}>No past sales of this item to this customer.</Text>
            }
            renderItem={({ item: r }) => {
              const disc =
                r.unitDiscount && r.unitDiscount > 0
                  ? `${formatMoney(r.unitDiscount)}/unit off`
                  : r.lineDiscount && r.lineDiscount > 0
                    ? `${formatMoney(r.lineDiscount)} off`
                    : null;
              return (
                <View style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.invoice} numberOfLines={1}>{r.invoiceNumber}</Text>
                    <Text style={styles.meta}>
                      {formatDate(r.saleDate)} · qty {r.quantity}
                      {disc ? ` · ${disc}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.price}>{formatMoney(r.unitPrice, { showPaise: true })}</Text>
                </View>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function formatDate(d: string): string {
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

const makeStyles = (colors: ReturnType<typeof useColors>, bottomInset: number) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 18,
      paddingBottom: bottomInset + 16,
      maxHeight: '70%',
    },
    title: { fontSize: 17, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    subtitle: {
      fontSize: 13,
      fontFamily: 'Outfit_400Regular',
      color: colors.mutedForeground,
      marginBottom: 10,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    invoice: { fontSize: 14, fontFamily: 'Outfit_600SemiBold', color: colors.foreground },
    meta: { fontSize: 12, fontFamily: 'Outfit_400Regular', color: colors.mutedForeground, marginTop: 1 },
    price: { fontSize: 15, fontFamily: 'Outfit_700Bold', color: colors.foreground },
    empty: {
      fontSize: 13,
      fontFamily: 'Outfit_400Regular',
      color: colors.mutedForeground,
      paddingVertical: 20,
      textAlign: 'center',
    },
  });
