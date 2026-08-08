export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

export type IndianState = typeof INDIAN_STATES[number];

/**
 * Official GST state codes — mirrors the server's map in
 * api-server/src/lib/gstTransfer.ts (including legacy aliases like
 * Orissa/Odisha and Uttaranchal/Uttarakhand from old free-text rows).
 * Keep the two in sync: the POS GST preview must agree with what the
 * server stores on save.
 */
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03',
  'chandigarh': '04', 'uttarakhand': '05', 'uttaranchal': '05',
  'haryana': '06', 'delhi': '07', 'rajasthan': '08',
  'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
  'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17',
  'assam': '18', 'west bengal': '19', 'jharkhand': '20',
  'odisha': '21', 'orissa': '21', 'chhattisgarh': '22',
  'madhya pradesh': '23', 'gujarat': '24',
  'dadra and nagar haveli and daman and diu': '26', 'daman and diu': '26',
  'maharashtra': '27', 'karnataka': '29', 'goa': '30',
  'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33',
  'puducherry': '34', 'andaman and nicobar islands': '35',
  'telangana': '36', 'andhra pradesh': '37', 'ladakh': '38',
};

export function stateCodeFromState(state: string | null | undefined): string {
  if (!state) return '';
  return STATE_CODES[state.toLowerCase().trim()] ?? '';
}

/**
 * Client mirror of the server's isInterStateSupply (gstTransfer.ts): compare
 * official state codes when both resolve (folding aliases), otherwise the
 * normalised names. Missing customer state (walk-in) or missing seller state
 * → intrastate. The server recomputes on save and stays authoritative.
 */
export function isInterStateSupply(
  seller: { state?: string | null; stateCode?: string | null },
  customerState: string | null | undefined,
): boolean {
  const custName = (customerState ?? '').trim().toLowerCase();
  if (!custName) return false;
  const sellerName = (seller.state ?? '').trim().toLowerCase();
  const sellerCode = (seller.stateCode ?? '').trim() || stateCodeFromState(sellerName);
  const custCode = stateCodeFromState(custName);
  if (sellerCode && custCode) return sellerCode !== custCode;
  if (!sellerName) return false;
  return sellerName !== custName;
}
