import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      await login(username.trim(), password);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace('/(tabs)');
    } catch (err: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg =
        err?.payload?.error ||
        err?.message ||
        'Invalid username or password.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const styles = makeStyles(colors, insets);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        bounces={false}
      >
        {/* Brand header */}
        <View style={styles.brandSection}>
          <View style={styles.logoCircle}>
            <Feather name="briefcase" size={36} color={colors.primaryForeground} />
          </View>
          <Text style={styles.brandName}>Frozen Fruits</Text>
          <Text style={styles.brandSub}>Employee Portal</Text>
        </View>

        {/* Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sign in</Text>
          <Text style={styles.cardSub}>Use your employee credentials</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={14} color={colors.destructive} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Username */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Username</Text>
            <View style={styles.inputWrapper}>
              <Feather name="user" size={16} color={colors.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Enter username"
                placeholderTextColor={colors.mutedForeground}
                value={username}
                onChangeText={(t) => { setUsername(t); setError(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                returnKeyType="next"
                editable={!isLoading}
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputWrapper}>
              <Feather name="lock" size={16} color={colors.mutedForeground} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, styles.inputFlex]}
                placeholder="Enter password"
                placeholderTextColor={colors.mutedForeground}
                value={password}
                onChangeText={(t) => { setPassword(t); setError(null); }}
                secureTextEntry={!showPassword}
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
                editable={!isLoading}
              />
              <Pressable
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={8}
                style={styles.eyeBtn}
              >
                <Feather
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={16}
                  color={colors.mutedForeground}
                />
              </Pressable>
            </View>
          </View>

          {/* Submit */}
          <Pressable
            style={({ pressed }) => [
              styles.loginBtn,
              pressed && styles.loginBtnPressed,
              isLoading && styles.loginBtnDisabled,
            ]}
            onPress={handleLogin}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color={colors.primaryForeground} size="small" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.footer}>Frozen Fruits ERP</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, insets: { top: number; bottom: number }) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background },
    container: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 24),
      paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 32),
    },
    brandSection: {
      alignItems: 'center',
      marginBottom: 40,
    },
    logoCircle: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.3,
      shadowRadius: 16,
      elevation: 8,
    },
    brandName: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
      letterSpacing: -0.5,
    },
    brandSub: {
      fontSize: 14,
      color: colors.mutedForeground,
      marginTop: 4,
      fontFamily: 'Outfit_400Regular',
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 24,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 3,
    },
    cardTitle: {
      fontSize: 22,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Outfit_700Bold',
      marginBottom: 4,
    },
    cardSub: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginBottom: 20,
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.destructive + '12',
      borderRadius: 8,
      padding: 12,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.destructive + '30',
    },
    errorText: {
      fontSize: 13,
      color: colors.destructive,
      flex: 1,
      fontFamily: 'Outfit_400Regular',
    },
    fieldGroup: { marginBottom: 16 },
    label: {
      fontSize: 13,
      fontWeight: '600' as const,
      color: colors.foreground,
      marginBottom: 8,
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
      height: 48,
    },
    inputIcon: { marginRight: 10 },
    input: {
      flex: 1,
      fontSize: 15,
      color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
    },
    inputFlex: { flex: 1 },
    eyeBtn: { padding: 4, marginLeft: 8 },
    loginBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      height: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 8,
    },
    loginBtnPressed: { opacity: 0.85 },
    loginBtnDisabled: { opacity: 0.6 },
    loginBtnText: {
      color: colors.primaryForeground,
      fontSize: 16,
      fontWeight: '600' as const,
      fontFamily: 'Outfit_600SemiBold',
    },
    footer: {
      textAlign: 'center',
      marginTop: 32,
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
    },
  });
}
