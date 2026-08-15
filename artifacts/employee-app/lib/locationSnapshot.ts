/**
 * Module-level location snapshot read by the api-client header getter.
 *
 * Lives in its own module (not LocationContext) so AuthContext can clear it
 * synchronously during login/logout/401 WITHOUT a circular import. If the
 * snapshot only changed inside LocationProvider's effect, there would be a
 * window between an account change and that effect where API requests still
 * carried the PREVIOUS user's warehouse/outlet headers.
 */

export interface LocationSnapshot {
  locationType: 'warehouse' | 'outlet' | 'headoffice' | 'all';
  locationId: number | null;
  locationName: string;
}

let current: LocationSnapshot | null = null;

export function getLocationSnapshot(): LocationSnapshot | null {
  return current;
}

export function setLocationSnapshot(s: LocationSnapshot): void {
  current = s;
}

export function clearLocationSnapshot(): void {
  current = null;
}

/**
 * The part of a selection that actually reaches the server: only
 * warehouse/outlet selections ride as x-location headers; HO/All send none.
 * Two states with the same signature produce identical requests.
 */
export function headerSignature(s: LocationSnapshot | null): string {
  if (s && (s.locationType === 'warehouse' || s.locationType === 'outlet') && s.locationId) {
    return `${s.locationType}:${s.locationId}`;
  }
  return '';
}
