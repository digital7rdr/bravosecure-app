/**
 * SET-08 — privacy-toggle burst race. `togglePrivacy` fires one HTTP
 * round-trip per Switch tap with no sequencing: an older response
 * resolving late clobbered the newest tap's optimistic state, and the
 * failure path reverted to a stale captured snapshot. The screen now
 * routes every request through `createLatestWins` — a per-field
 * monotonically increasing seq — so only the newest request per field
 * may commit (resolve) or revert (reject) its fields.
 */

// The screen module pulls in RN / navigation / theme at module scope —
// stub the lot so the pure guard factory is importable under node.
jest.mock('react-native', () => ({
  StyleSheet: {create: (s: unknown) => s},
  Alert: {alert: jest.fn()},
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  TextInput: 'TextInput',
  Switch: 'Switch',
  StatusBar: 'StatusBar',
  ActivityIndicator: 'ActivityIndicator',
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({__esModule: true, default: 'Icon'}), {virtual: true});
jest.mock('@react-navigation/native', () => ({useNavigation: () => ({goBack: jest.fn(), navigate: jest.fn()})}));
jest.mock(
  '@react-native-async-storage/async-storage',
  () => ({__esModule: true, default: {getItem: jest.fn(async () => null)}}),
  {virtual: true},
);
jest.mock('@theme/index', () => ({Colors: {background: '#000', primary: '#00F'}}), {virtual: true});
jest.mock('@bravo/messenger-core', () => ({UsersHttpClient: class UsersHttpClient {}}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://api.test'}), {virtual: true});
jest.mock('@services/api', () => ({tokenStore: {get: () => null}}), {virtual: true});
jest.mock('@components/KeyboardAvoidingScreen', () => ({__esModule: true, default: 'KeyboardAvoidingScreen'}), {virtual: true});
jest.mock(
  '@/modules/messenger/store/privacySettings',
  () => ({setReadReceiptsEnabled: jest.fn(async () => {})}),
  {virtual: true},
);
jest.mock('@utils/scaling', () => ({scaleTextStyles: (s: unknown) => s}), {virtual: true});
// P3-B-2 — the screen now reads the owner-scoped backup flag, pulling in
// the auth store (whose real module drags axios/expo deps into node).
jest.mock(
  '@store/authStore',
  () => ({useAuthStore: (selector: (s: unknown) => unknown) => selector({user: null})}),
  {virtual: true},
);

import {createLatestWins} from '../../../screens/messenger/MessengerSettingsScreen';

describe('createLatestWins (SET-08 privacy-toggle burst guard)', () => {
  it('supersedes an older request for the same field', () => {
    const begin = createLatestWins<'readReceiptsEnabled'>();
    const first = begin(['readReceiptsEnabled']);
    const second = begin(['readReceiptsEnabled']);
    // The older request must neither commit nor revert; the newest owns
    // the field regardless of which response lands first.
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('leaves only the last tap of a burst live', () => {
    const begin = createLatestWins<'lastSeenVisible'>();
    const probes = [
      begin(['lastSeenVisible']),
      begin(['lastSeenVisible']),
      begin(['lastSeenVisible']),
    ];
    expect(probes.map(p => p())).toEqual([false, false, true]);
  });

  it('sequences fields independently', () => {
    const begin = createLatestWins<'lastSeenVisible' | 'readReceiptsEnabled'>();
    const seen1 = begin(['lastSeenVisible']);
    const receipts1 = begin(['readReceiptsEnabled']);
    const seen2 = begin(['lastSeenVisible']);
    // A newer lastSeen tap invalidates only lastSeen; the in-flight
    // read-receipts request keeps its claim.
    expect(seen1()).toBe(false);
    expect(seen2()).toBe(true);
    expect(receipts1()).toBe(true);
  });

  it('invalidates a multi-field request when ANY of its fields is re-begun', () => {
    const begin = createLatestWins<'lastSeenVisible' | 'readReceiptsEnabled'>();
    const both = begin(['lastSeenVisible', 'readReceiptsEnabled']);
    const seenOnly = begin(['lastSeenVisible']);
    expect(both()).toBe(false);
    expect(seenOnly()).toBe(true);
  });

  it('stays latest across the async gap until superseded', async () => {
    const begin = createLatestWins<'readReceiptsEnabled'>();
    const probe = begin(['readReceiptsEnabled']);
    await Promise.resolve();
    expect(probe()).toBe(true);
    begin(['readReceiptsEnabled']);
    await Promise.resolve();
    expect(probe()).toBe(false);
  });
});
