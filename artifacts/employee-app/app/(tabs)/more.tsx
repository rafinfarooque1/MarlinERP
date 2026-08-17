import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';
import { confirmDialog } from '@/lib/dialogs';

/**
 * "More" tab — home for everything that doesn't get its own tab: money
 * vouchers (permission-gated), the personal employee section (payslips,
 * attendance, leaves — these keep working for ERP users too) and profile.
 */
export default function MoreScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { employee, logout } = useAuth();
  const { canView } = useErpPermissions();

  const showReceipts = canView(PAGE.receiptVoucher);
  const showPayments = canView(PAGE.paymentVoucher);

  const styles = makeStyles(colors);

  const handleLogout = () => {
    confirmDialog({
      title: 'Log out',
      message: 'Are you sure you want to log out?',
      confirmText: 'Log Out',
      cancelText: 'Cancel',
      destructive: true,
      onConfirm: () => { logout(); },
    });
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32 }}
    >
      <Text style={styles.title}>More</Text>

      {(showReceipts || showPayments) && (
        <Section title="Business" colors={colors}>
          {showReceipts && (
            <MenuRow
              icon="arrow-down-left"
              label="Receipt Vouchers"
              sublabel="Money received from customers"
              onPress={() => router.push('/receipt-vouchers')}
              colors={colors}
            />
          )}
          {showPayments && (
            <MenuRow
              icon="arrow-up-right"
              label="Payment Vouchers"
              sublabel="Money paid out"
              onPress={() => router.push('/payment-vouchers')}
              colors={colors}
              last
            />
          )}
        </Section>
      )}

      <Section title="Personal" colors={colors}>
        <MenuRow
          icon="file-text"
          label="Payslips"
          onPress={() => router.push('/(tabs)/payslips')}
          colors={colors}
        />
        <MenuRow
          icon="calendar"
          label="Attendance"
          onPress={() => router.push('/(tabs)/attendance')}
          colors={colors}
        />
        <MenuRow
          icon="clock"
          label="Leaves"
          onPress={() => router.push('/(tabs)/leaves')}
          colors={colors}
          last
        />
      </Section>

      <Section title="Account" colors={colors}>
        <MenuRow
          icon="user"
          label="Profile"
          sublabel={employee ? `${employee.name} · ${employee.hierarchyName}` : undefined}
          onPress={() => router.push('/profile')}
          colors={colors}
        />
        <MenuRow
          icon="log-out"
          label="Log Out"
          onPress={handleLogout}
          colors={colors}
          destructive
          last
        />
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  colors,
  children,
}: {
  title: string;
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginTop: 20, paddingHorizontal: 20 }}>
      <Text
        style={{
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: 1,
          color: colors.mutedForeground,
          fontFamily: 'Outfit_600SemiBold',
          marginBottom: 8,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function MenuRow({
  icon,
  label,
  sublabel,
  onPress,
  colors,
  destructive,
  last,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  sublabel?: string;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
  destructive?: boolean;
  last?: boolean;
}) {
  const tint = destructive ? colors.destructive : colors.primary;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 14,
          minHeight: 56,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          backgroundColor: pressed ? colors.muted : 'transparent',
        },
      ]}
    >
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: tint + '18',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name={icon} size={16} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: 15,
            color: destructive ? colors.destructive : colors.foreground,
            fontFamily: 'Outfit_500Medium',
          }}
        >
          {label}
        </Text>
        {sublabel ? (
          <Text
            style={{
              fontSize: 12,
              color: colors.mutedForeground,
              fontFamily: 'Outfit_400Regular',
              marginTop: 1,
            }}
          >
            {sublabel}
          </Text>
        ) : null}
      </View>
      {!destructive && <Feather name="chevron-right" size={18} color={colors.mutedForeground} />}
    </Pressable>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: { flex: 1 },
    title: {
      fontSize: 24,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
      paddingHorizontal: 20,
    },
  });
}
