import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { notify } from '@/lib/dialogs';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { customFetch } from '@workspace/api-client-react';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after the server confirms the password change. */
  onChanged: () => void;
}

/**
 * In-app password change. Required for accounts flagged mustChangePassword —
 * employees without web-portal access would otherwise be stuck on a warning
 * banner forever. Server policy (length/complexity) is enforced server-side;
 * we only pre-check the parts we can (non-empty, match, differs from current).
 */
export function ChangePasswordModal({ visible, onClose, onChanged }: Props) {
  const colors = useColors();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setShow(false);
    setError(null);
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!current || !next || !confirm) {
      setError('Please fill in all three fields.');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    if (next === current) {
      setError('The new password must be different from the current one.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await customFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      reset();
      onChanged();
      onClose();
      notify('Password changed', 'Your new password is active. Use it the next time you sign in.');
    } catch (e: any) {
      setError(e?.data?.error || e?.payload?.error || e?.message || 'Could not change the password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const s = makeStyles(colors);

  const field = (
    label: string,
    value: string,
    setValue: (t: string) => void,
    placeholder: string,
  ) => (
    <View style={s.fieldGroup}>
      <Text style={s.label}>{label}</Text>
      <View style={s.inputWrapper}>
        <Feather name="lock" size={16} color={colors.mutedForeground} style={{ marginRight: 10 }} />
        <TextInput
          style={s.input}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          value={value}
          onChangeText={(t) => { setValue(t); setError(null); }}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
        />
      </View>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <KeyboardAvoidingView
        style={s.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.card}>
          <View style={s.headerRow}>
            <Text style={s.title}>Change Password</Text>
            <Pressable onPress={handleClose} hitSlop={8} disabled={busy}>
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {error ? (
            <View style={s.errorBox}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={s.errorText}>{error}</Text>
            </View>
          ) : null}

          {field('Current password', current, setCurrent, 'Enter current password')}
          {field('New password', next, setNext, 'Enter new password')}
          {field('Confirm new password', confirm, setConfirm, 'Re-enter new password')}

          <Pressable onPress={() => setShow((v) => !v)} style={s.showRow} hitSlop={6}>
            <Feather name={show ? 'eye-off' : 'eye'} size={14} color={colors.mutedForeground} />
            <Text style={s.showText}>{show ? 'Hide passwords' : 'Show passwords'}</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [s.submitBtn, (pressed || busy) && { opacity: 0.75 }]}
            onPress={submit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryForeground} size="small" />
            ) : (
              <Text style={s.submitText}>Update Password</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'center',
      paddingHorizontal: 20,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
    },
    title: {
      fontSize: 18,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.destructive + '12',
      borderRadius: 8,
      padding: 10,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: colors.destructive + '30',
    },
    errorText: { fontSize: 13, color: colors.destructive, flex: 1, fontFamily: 'Outfit_400Regular' },
    fieldGroup: { marginBottom: 14 },
    label: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.foreground,
      marginBottom: 6,
      fontFamily: 'Outfit_600SemiBold',
    },
    inputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.background,
      paddingHorizontal: 12,
      height: 46,
    },
    input: { flex: 1, fontSize: 15, color: colors.foreground, fontFamily: 'Outfit_400Regular' },
    showRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 16 },
    showText: { fontSize: 12, color: colors.mutedForeground, fontFamily: 'Outfit_400Regular' },
    submitBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
    },
    submitText: {
      color: colors.primaryForeground,
      fontSize: 15,
      fontWeight: '600' as const,
      fontFamily: 'Outfit_600SemiBold',
    },
  });
}
