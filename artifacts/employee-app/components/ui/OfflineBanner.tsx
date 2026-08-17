import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useNetworkState } from 'expo-network';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

/**
 * Global "No Internet Connection" banner. Purely informational — screens
 * must still handle request failures; financial flows rely on server-side
 * idempotency, never on this banner, to prevent duplicates.
 */
export function OfflineBanner() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const network = useNetworkState();

  // Only show when we KNOW we're offline; undefined means "not sure yet".
  if (network.isConnected !== false) return null;

  return (
    <View
      style={[
        styles.banner,
        {
          top: insets.top,
          backgroundColor: colors.destructive,
        },
      ]}
      pointerEvents="none"
    >
      <Feather name="wifi-off" size={14} color={colors.destructiveForeground} />
      <Text style={[styles.text, { color: colors.destructiveForeground }]}>
        No Internet Connection
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 12,
    right: 12,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    zIndex: 1000,
    elevation: 10,
  },
  text: {
    fontSize: 13,
    fontFamily: 'Outfit_600SemiBold',
  },
});
