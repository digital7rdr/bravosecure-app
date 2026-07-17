/**
 * Pure Save-button guard for the Step 21 shift editor. Mirrors the server's
 * invariants (OrgManagerGuard createShift/assignCpos) so an invalid draft fails
 * fast on-device. Kept dependency-free so it is unit-testable without RN.
 */
export function validateShiftDraft(d: {
  startMs: number;
  endMs: number;
  selectedCount: number;
  hasCoords: boolean;
  radius: number;
}): string | null {
  if (!(d.startMs < d.endMs)) {
    return 'The end time must be after the start time.';
  }
  if (d.selectedCount < 1) {
    return 'Select at least one CPO to assign.';
  }
  if (d.hasCoords && !(d.radius > 0)) {
    return 'Approved radius must be greater than 0 m.';
  }
  return null;
}
