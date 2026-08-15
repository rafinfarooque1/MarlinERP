import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ComingSoon } from '@/components/ComingSoon';
import { LocationSelector } from '@/components/LocationSelector';
import { useColors } from '@/hooks/useColors';

export default function SalesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.foreground }]}>Sales</Text>
        <LocationSelector />
      </View>
      <ComingSoon
        icon="shopping-cart"
        title="Sales"
        description="Browse sales, share invoices and bill new sales — coming in the next update."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 20, gap: 10 },
  title: { fontSize: 24, fontFamily: 'Outfit_700Bold' },
});
