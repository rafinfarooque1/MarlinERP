import React from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Tabs } from 'expo-router';
import { Icon, Label, NativeTabs } from 'expo-router/unstable-native-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PAGE, useErpPermissions } from '@/hooks/useErpPermissions';

/**
 * Permission-driven tab shape:
 *  • ERP users (any business-module view right): Home, Sales*, Dispatch*,
 *    Stock*, More — starred tabs appear only with that module's view right.
 *    Payslips/Attendance/Leaves stay routable and live in the More menu.
 *  • Pure employees: the original Home, Payslips, Attendance, Leaves tabs.
 * Until permissions load we show the employee shape — safe for everyone,
 * no ERP flash. Gating here is display-only; the API re-checks every call.
 */
interface TabVisibility {
  sales: boolean;
  dispatch: boolean;
  stock: boolean;
  erp: boolean;
}

function useTabVisibility(): TabVisibility {
  const { ready, canView } = useErpPermissions();
  const sales = ready && canView(PAGE.sales);
  const dispatch = ready && canView(PAGE.dispatch);
  const stock = ready && canView(PAGE.stock);
  const vouchers =
    ready && (canView(PAGE.receiptVoucher) || canView(PAGE.paymentVoucher));
  const dashboard = ready && canView(PAGE.dashboard);
  return {
    sales,
    dispatch,
    stock,
    erp: sales || dispatch || stock || vouchers || dashboard,
  };
}

// SF Symbols: use 'as any' since calendar.fill / leaf.fill are valid SF symbols
// but may not appear in the narrow SFSymbols7_0 type exported by expo-symbols.
/* eslint-disable @typescript-eslint/no-explicit-any */

function NativeTabLayout({ vis }: { vis: TabVisibility }) {
  // Every screen gets a trigger and visibility rides the `hidden` flag: a
  // screen without a trigger is unreachable in the native navigator, which is
  // exactly how Payslips/Attendance/Leaves broke on iOS for ERP users — the
  // More-menu links pushed routes the tab bar never registered. Conditional
  // `{cond && <Trigger/>}` children also emit "children must be of type
  // Screen" warnings, so `hidden` handles both.
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: 'house' as any, selected: 'house.fill' as any }} />
        <Label>Home</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sales" hidden={!vis.sales}>
        <Icon sf={{ default: 'cart' as any, selected: 'cart.fill' as any }} />
        <Label>Sales</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="dispatch" hidden={!vis.dispatch}>
        <Icon sf={{ default: 'shippingbox' as any, selected: 'shippingbox.fill' as any }} />
        <Label>Dispatch</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="stock" hidden={!vis.stock}>
        <Icon sf={{ default: 'archivebox' as any, selected: 'archivebox.fill' as any }} />
        <Label>Stock</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more" hidden={!vis.erp}>
        <Icon sf={{ default: 'ellipsis.circle' as any, selected: 'ellipsis.circle.fill' as any }} />
        <Label>More</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="payslips" hidden={vis.erp}>
        <Icon sf={{ default: 'doc.text' as any, selected: 'doc.text.fill' as any }} />
        <Label>Payslips</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="attendance" hidden={vis.erp}>
        <Icon sf={{ default: 'calendar' as any, selected: 'calendar.fill' as any }} />
        <Label>Attendance</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="leaves" hidden={vis.erp}>
        <Icon sf={{ default: 'leaf' as any, selected: 'leaf.fill' as any }} />
        <Label>Leaves</Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function ClassicTabLayout({ vis }: { vis: TabVisibility }) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';
  const safeAreaInsets = useSafeAreaInsets();

  const featherIcon =
    (name: React.ComponentProps<typeof Feather>['name']) =>
    ({ color }: { color: string }) => (
      <Feather name={name} size={22} color={color} />
    );

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarLabelStyle: {
          fontFamily: 'Outfit_500Medium',
          fontSize: 11,
        },
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.background,
          borderTopWidth: isWeb ? 1 : 0,
          borderTopColor: colors.border,
          elevation: 0,
          paddingBottom: isWeb ? 0 : safeAreaInsets.bottom,
          ...(isWeb ? { height: 84 } : {}),
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={100}
              tint={isDark ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : isWeb ? (
            <View
              style={[
                StyleSheet.absoluteFill,
                { backgroundColor: colors.background },
              ]}
            />
          ) : null,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: featherIcon('home'),
        }}
      />
      <Tabs.Screen
        name="sales"
        options={{
          title: 'Sales',
          tabBarIcon: featherIcon('shopping-cart'),
          href: vis.sales ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="dispatch"
        options={{
          title: 'Dispatch',
          tabBarIcon: featherIcon('truck'),
          href: vis.dispatch ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'Stock',
          tabBarIcon: featherIcon('package'),
          href: vis.stock ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: featherIcon('menu'),
          href: vis.erp ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="payslips"
        options={{
          title: 'Payslips',
          tabBarIcon: featherIcon('file-text'),
          href: vis.erp ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: 'Attendance',
          tabBarIcon: featherIcon('calendar'),
          href: vis.erp ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="leaves"
        options={{
          title: 'Leaves',
          tabBarIcon: featherIcon('clock'),
          href: vis.erp ? null : undefined,
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const vis = useTabVisibility();
  if (isLiquidGlassAvailable()) {
    return <NativeTabLayout vis={vis} />;
  }
  return <ClassicTabLayout vis={vis} />;
}
