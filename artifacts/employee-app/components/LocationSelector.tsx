import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useListOutlets, useListWarehouses } from '@workspace/api-client-react';
import { SearchablePicker, PickerItem } from '@/components/ui/SearchablePicker';
import { useAuth } from '@/contexts/AuthContext';
import { ALL_LOCATIONS, LocationState, useLocationContext } from '@/contexts/LocationContext';
import { useColors } from '@/hooks/useColors';

/**
 * The "Current Location" control — mobile mirror of the web sidebar block.
 *
 * Branch (warehouse/outlet) employees see a fixed label: their data scope is
 * decided by the server and offering a dead dropdown would misstate who
 * controls it. Head Office users can narrow the whole app's view to one
 * location, or see everything.
 */
export function LocationSelector() {
  const colors = useColors();
  const { token, employee } = useAuth();
  const { location, locked, setLocation } = useLocationContext();
  const [open, setOpen] = useState(false);

  const isHeadOffice = employee?.branchType === 'headoffice';

  // Only Head Office users ever open the picker; branch users never fetch.
  const { data: warehouses } = useListWarehouses(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token && isHeadOffice, staleTime: 300_000, retry: false } as any },
  );
  const { data: outlets } = useListOutlets(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!token && isHeadOffice, staleTime: 300_000, retry: false } as any },
  );

  const items = useMemo<PickerItem[]>(() => {
    const list: PickerItem[] = [
      { key: 'all', label: 'All Locations', sublabel: 'Everything you may see' },
      { key: 'headoffice', label: 'Head Office', sublabel: 'Head Office view' },
    ];
    for (const w of warehouses ?? []) {
      list.push({ key: `warehouse:${w.id}`, label: w.name ?? `Warehouse ${w.id}`, sublabel: 'Warehouse' });
    }
    for (const o of outlets ?? []) {
      list.push({ key: `outlet:${o.id}`, label: o.name ?? `Outlet ${o.id}`, sublabel: 'Outlet' });
    }
    return list;
  }, [warehouses, outlets]);

  const selectedKey =
    location.locationType === 'all'
      ? 'all'
      : location.locationType === 'headoffice'
      ? 'headoffice'
      : `${location.locationType}:${location.locationId}`;

  const handleSelect = (item: PickerItem) => {
    let next: LocationState;
    if (item.key === 'all') next = ALL_LOCATIONS;
    else if (item.key === 'headoffice')
      next = { locationType: 'headoffice', locationId: null, locationName: 'Head Office' };
    else {
      const [type, id] = item.key.split(':');
      next = {
        locationType: type as 'warehouse' | 'outlet',
        locationId: Number(id),
        locationName: item.label,
      };
    }
    setLocation(next);
  };

  const icon =
    location.locationType === 'warehouse'
      ? 'box'
      : location.locationType === 'outlet'
      ? 'shopping-bag'
      : location.locationType === 'headoffice'
      ? 'map-pin'
      : 'layers';

  const styles = makeStyles(colors);

  const chipInner = (
    <>
      <Feather name={icon} size={14} color={colors.primary} />
      <Text style={styles.chipText} numberOfLines={1}>
        {location.locationName || 'All Locations'}
      </Text>
      {!locked && <Feather name="chevron-down" size={14} color={colors.mutedForeground} />}
    </>
  );

  if (locked) {
    return <View style={styles.chip}>{chipInner}</View>;
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.chip, pressed && { opacity: 0.7 }]}
        accessibilityLabel="Change current location"
      >
        {chipInner}
      </Pressable>
      <SearchablePicker
        visible={open}
        onClose={() => setOpen(false)}
        title="Current Location"
        items={items}
        selectedKey={selectedKey}
        onSelect={handleSelect}
        searchPlaceholder="Search locations…"
      />
    </>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      height: 34,
      maxWidth: 260,
    },
    chipText: {
      fontSize: 13,
      color: colors.foreground,
      fontFamily: 'Outfit_500Medium',
      flexShrink: 1,
    },
  });
}
