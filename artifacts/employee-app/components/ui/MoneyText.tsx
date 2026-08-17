import React from 'react';
import { Text, TextStyle, StyleProp } from 'react-native';

/**
 * Indian-format money display: ₹1,23,456.78. Paise shown only when present
 * (or always, with `showPaise`). Keep ALL money rendering on this helper so
 * the format never drifts between screens.
 */
export function formatMoney(value: number, opts?: { showPaise?: boolean }): string {
  const hasPaise = opts?.showPaise || Math.round(value * 100) % 100 !== 0;
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: hasPaise ? 2 : 0,
  })}`;
}

export function MoneyText({
  value,
  showPaise,
  style,
}: {
  value: number;
  showPaise?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={style}>{formatMoney(value, { showPaise })}</Text>;
}
