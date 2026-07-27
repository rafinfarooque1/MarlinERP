/**
 * Marlin Employee App — design tokens synced from sibling marlin-erp artifact.
 * Primary: Cyan/Teal (#0d89a5 light / #00cfff dark)
 * Font: Outfit (matches web app)
 */

const colors = {
  light: {
    text: '#0a1120',
    tint: '#0d89a5',
    background: '#f4f6f8',
    foreground: '#0a1120',
    card: '#ffffff',
    cardForeground: '#0a1120',
    primary: '#0d89a5',
    primaryForeground: '#ffffff',
    secondary: '#e4e7f1',
    secondaryForeground: '#121d38',
    muted: '#eceef5',
    mutedForeground: '#596b85',
    accent: '#0d89a5',
    accentForeground: '#ffffff',
    destructive: '#ef2424',
    destructiveForeground: '#ffffff',
    border: '#d3d8e8',
    input: '#d3d8e8',
    success: '#16a34a',
    successForeground: '#ffffff',
    warning: '#d97706',
    warningForeground: '#ffffff',
  },
  dark: {
    text: '#f4f9fc',
    tint: '#00cfff',
    background: '#070c1a',
    foreground: '#f4f9fc',
    card: '#0c1529',
    cardForeground: '#f4f9fc',
    primary: '#00cfff',
    primaryForeground: '#07111f',
    secondary: '#1a2847',
    secondaryForeground: '#f4f9fc',
    muted: '#111c38',
    mutedForeground: '#8896b3',
    accent: '#00cfff',
    accentForeground: '#07111f',
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',
    border: '#182040',
    input: '#182040',
    success: '#22c55e',
    successForeground: '#ffffff',
    warning: '#f59e0b',
    warningForeground: '#000000',
  },
  // Synced from sibling: --radius: 0.25rem = 4px
  radius: 4,
};

export default colors;
