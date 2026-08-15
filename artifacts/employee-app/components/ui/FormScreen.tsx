import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';

/**
 * Full-screen mobile form/detail scaffold: back header, keyboard-aware
 * scrolling body, and an optional sticky bottom action area. Every ERP
 * transaction flow (New Sale, vouchers…) builds on this — never a desktop
 * popup squeezed into mobile.
 */
export function FormScreen({
  title,
  subtitle,
  onBack,
  headerRight,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  headerRight?: React.ReactNode;
  /** Sticky bottom action area (e.g. a submit button). */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors, insets);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack ?? (() => router.back())}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        >
          <Feather name="chevron-left" size={24} color={colors.foreground} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {headerRight ? <View>{headerRight}</View> : null}
      </View>

      <KeyboardAwareScrollViewCompat
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
      >
        {children}
      </KeyboardAwareScrollViewCompat>

      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

/** Large touch-friendly primary action button for FormScreen footers. */
export function PrimaryButton({
  label,
  onPress,
  disabled,
  loading,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  destructive?: boolean;
}) {
  const colors = useColors();
  const bg = destructive ? colors.destructive : colors.primary;
  const fg = destructive ? colors.destructiveForeground : colors.primaryForeground;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          opacity: disabled || loading ? 0.5 : pressed ? 0.85 : 1,
          borderRadius: 12,
          height: 52,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Text
        style={{
          color: fg,
          fontSize: 16,
          fontFamily: 'Outfit_600SemiBold',
        }}
      >
        {loading ? 'Please wait…' : label}
      </Text>
    </Pressable>
  );
}

function makeStyles(
  colors: ReturnType<typeof useColors>,
  insets: { top: number; bottom: number },
) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: insets.top + 8,
      paddingBottom: 12,
      paddingHorizontal: 12,
      backgroundColor: colors.background,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: 4,
    },
    backBtn: { padding: 4 },
    headerText: { flex: 1 },
    title: {
      fontSize: 18,
      color: colors.foreground,
      fontFamily: 'Outfit_600SemiBold',
    },
    subtitle: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 1,
    },
    body: { flex: 1 },
    bodyContent: { padding: 16, paddingBottom: 32 },
    footer: {
      padding: 16,
      paddingBottom: insets.bottom + 16,
      backgroundColor: colors.background,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
  });
}
