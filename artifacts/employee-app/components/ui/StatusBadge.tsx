import React from 'react';
import { Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

export type BadgeTone = 'success' | 'warning' | 'destructive' | 'info' | 'muted';

/**
 * Compact colored status pill — the app-wide status indicator style
 * (same look as the payslip status badge on Home).
 */
export function StatusBadge({ label, tone = 'muted' }: { label: string; tone?: BadgeTone }) {
  const colors = useColors();
  const toneColor: Record<BadgeTone, string> = {
    success: colors.success,
    warning: colors.warning,
    destructive: colors.destructive,
    info: colors.primary,
    muted: colors.mutedForeground,
  };
  const c = toneColor[tone];
  return (
    <View
      style={{
        backgroundColor: c + '20',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 3,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600' as const,
          color: c,
          fontFamily: 'Outfit_600SemiBold',
        }}
      >
        {label}
      </Text>
    </View>
  );
}
