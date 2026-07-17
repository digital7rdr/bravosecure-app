import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Dept Chat v2 — Step 19. The dedicated "Departmental" module must expose the
 * PDF's fixed 5-tab bottom nav, IN ORDER: Home · Channels · Attend · Incident ·
 * Vault, role-branch its Attend/Incident roots, and reuse the File-Vault MFA
 * gate rather than bypass it. A source scan of DepartmentalNavigator is the
 * structural guard (mirrors cpoCapability.test.ts) — the shell can't drift
 * without this failing.
 */
const SRC = readFileSync(join(__dirname, '..', 'DepartmentalNavigator.tsx'), 'utf8');

describe('Departmental module shell (Step 19)', () => {
  it('renders EXACTLY the five PDF tabs in order (Home · Channels · Attend · Incident · Vault)', () => {
    const tabs = [...SRC.matchAll(/<Tab\.Screen name="(\w+)"/g)].map(m => m[1]);
    expect(tabs).toEqual(['Home', 'Channels', 'Attend', 'Incident', 'Vault']);
  });

  it('branches the Attend + Incident roots by role (manager vs member)', () => {
    expect(SRC).toContain("isManager ? 'AdminAttendance' : 'Attendance'");
    // Member Incident root is the My-Reports list (Step 23); manager is the queue.
    expect(SRC).toContain("isManager ? 'IncidentQueue' : 'MyIncidents'");
  });

  it('reuses the File-Vault MFA gate in the Vault tab (no bypass)', () => {
    expect(SRC).toContain('component={VaultLockScreen}');
    expect(SRC).toContain('component={VaultScreen}');
  });
});
