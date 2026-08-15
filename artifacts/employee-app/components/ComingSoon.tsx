import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

/**
 * Placeholder body for ERP modules whose screens ship in later tasks.
 * The tab/menu entry is already permission-gated; this only fills the screen.
 */
export function ComingSoon({
  icon,
  title,
  description,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  description?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={[styles.iconWrap, { backgroundColor: colors.primary + '18' }]}>
          <Feather name={icon} size={28} color={colors.primary} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
        <Text style={[styles.desc, { color: colors.mutedForeground }]}>
          {description ?? 'This module is being prepared and will appear here soon.'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: 24 },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 18, fontFamily: 'Outfit_600SemiBold' },
  desc: {
    fontSize: 13,
    fontFamily: 'Outfit_400Regular',
    textAlign: 'center',
    lineHeight: 19,
  },
});
