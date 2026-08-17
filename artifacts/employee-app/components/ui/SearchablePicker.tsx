import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

/**
 * Searchable bottom-sheet picker — the app-wide replacement for dropdowns.
 * Every long selection list (customers, items, ledgers, locations…) uses
 * this: search field, scrollable results, current selection, optional clear.
 */

export interface PickerItem {
  key: string;
  label: string;
  sublabel?: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  items: PickerItem[];
  selectedKey?: string | null;
  onSelect: (item: PickerItem) => void;
  searchPlaceholder?: string;
  emptyText?: string;
  loading?: boolean;
  /** Optional "clear selection" row shown above the list. */
  clearLabel?: string;
  onClear?: () => void;
}

export function SearchablePicker({
  visible,
  onClose,
  title,
  items,
  selectedKey,
  onSelect,
  searchPlaceholder = 'Search…',
  emptyText = 'No results',
  loading = false,
  clearLabel,
  onClear,
}: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      i =>
        i.label.toLowerCase().includes(q) ||
        (i.sublabel ?? '').toLowerCase().includes(q),
    );
  }, [items, query]);

  const styles = makeStyles(colors, insets.bottom);

  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Text style={styles.title}>{title}</Text>
          <Pressable onPress={close} hitSlop={10} style={styles.closeBtn}>
            <Feather name="x" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>

        <View style={styles.searchBox}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={searchPlaceholder}
            placeholderTextColor={colors.mutedForeground}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Feather name="x-circle" size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
        </View>

        {loading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={i => i.key}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListHeaderComponent={
              clearLabel && onClear ? (
                <Pressable
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => {
                    onClear();
                    close();
                  }}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, { color: colors.mutedForeground }]}>
                      {clearLabel}
                    </Text>
                  </View>
                </Pressable>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>{emptyText}</Text>
              </View>
            }
            renderItem={({ item }) => {
              const selected = item.key === selectedKey;
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    selected && styles.rowSelected,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    onSelect(item);
                    close();
                  }}
                >
                  <View style={styles.rowText}>
                    <Text style={[styles.rowLabel, selected && { color: colors.primary }]}>
                      {item.label}
                    </Text>
                    {item.sublabel ? (
                      <Text style={styles.rowSublabel}>{item.sublabel}</Text>
                    ) : null}
                  </View>
                  {selected && <Feather name="check" size={18} color={colors.primary} />}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>, bottomInset: number) {
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '78%',
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingBottom: bottomInset + 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    handle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginTop: 8,
      marginBottom: 8,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    title: {
      fontSize: 16,
      color: colors.foreground,
      fontFamily: 'Outfit_600SemiBold',
    },
    closeBtn: { padding: 4 },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.muted,
      borderRadius: 10,
      paddingHorizontal: 12,
      height: 44,
      marginBottom: 8,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: colors.foreground,
      fontFamily: 'Outfit_400Regular',
      paddingVertical: 0,
    },
    list: { flexGrow: 0 },
    loadingBox: { padding: 32, alignItems: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    rowSelected: { backgroundColor: colors.primary + '10', borderRadius: 8 },
    rowPressed: { opacity: 0.7 },
    rowText: { flex: 1, marginRight: 8 },
    rowLabel: {
      fontSize: 15,
      color: colors.foreground,
      fontFamily: 'Outfit_500Medium',
    },
    rowSublabel: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
      marginTop: 1,
    },
    emptyBox: { padding: 32, alignItems: 'center' },
    emptyText: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Outfit_400Regular',
    },
  });
}
