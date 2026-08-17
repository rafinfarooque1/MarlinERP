import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { FormScreen, PrimaryButton } from '@/components/ui/FormScreen';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { confirmDialog } from '@/lib/dialogs';

export default function ProfileScreen() {
  const colors = useColors();
  const { employee, logout } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);

  const styles = makeStyles(colors);

  if (!employee) return null;

  const initials = employee.name
    .split(/\s+/)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const branchLabel =
    employee.branchType === 'headoffice'
      ? 'Head Office'
      : `${employee.branchName} (${employee.branchType === 'warehouse' ? 'Warehouse' : 'Outlet'})`;

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
    <FormScreen
      title="Profile"
      footer={<PrimaryButton label="Log Out" onPress={handleLogout} destructive />}
    >
      <View style={styles.avatarWrap}>
        {employee.photoUrl ? (
          <Image source={{ uri: employee.photoUrl }} style={styles.avatarImg} />
        ) : (
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        )}
        <Text style={styles.name}>{employee.name}</Text>
        <Text style={styles.role}>{employee.hierarchyName}</Text>
      </View>

      <View style={styles.card}>
        <InfoRow label="Username" value={employee.username} colors={colors} />
        <InfoRow label="Location" value={branchLabel} colors={colors} />
        <InfoRow label="Email" value={employee.email || '—'} colors={colors} />
        <InfoRow label="Phone" value={employee.phone || '—'} colors={colors} />
        <InfoRow
          label="Joined"
          value={
            employee.joinDate
              ? new Date(employee.joinDate).toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
              : '—'
          }
          colors={colors}
          last
        />
      </View>

      <View style={{ marginTop: 16 }}>
        <PrimaryButton label="Change Password" onPress={() => setShowChangePassword(true)} />
      </View>

      <ChangePasswordModal
        visible={showChangePassword}
        onClose={() => setShowChangePassword(false)}
        onChanged={() => setShowChangePassword(false)}
      />
    </FormScreen>
  );
}

function InfoRow({
  label,
  value,
  colors,
  last,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
  last?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
        gap: 12,
      }}
    >
      <Text
        style={{
          fontSize: 13,
          color: colors.mutedForeground,
          fontFamily: 'Outfit_400Regular',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontSize: 14,
          color: colors.foreground,
          fontFamily: 'Outfit_500Medium',
          flexShrink: 1,
          textAlign: 'right',
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    avatarWrap: { alignItems: 'center', marginBottom: 20 },
    avatarImg: { width: 84, height: 84, borderRadius: 42, marginBottom: 10 },
    avatarCircle: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
    },
    avatarText: {
      fontSize: 28,
      color: colors.primary,
      fontFamily: 'Outfit_700Bold',
    },
    name: { fontSize: 20, color: colors.foreground, fontFamily: 'Outfit_600SemiBold' },
    role: {
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 2,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
    },
  });
}
