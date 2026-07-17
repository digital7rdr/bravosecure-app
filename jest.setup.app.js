/**
 * Setup for the `app` jest project (RN component render tests).
 * Mocks the native modules that screens pull in transitively so a
 * component can mount under react-test-renderer without a device.
 * Add mocks here as new screens come under test.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-native-reanimated', () => {
  try {
    return require('react-native-reanimated/mock');
  } catch {
    return {};
  }
});

jest.mock('react-native-safe-area-context', () => {
  const inset = {top: 0, right: 0, bottom: 0, left: 0};
  return {
    SafeAreaProvider: ({children}) => children,
    SafeAreaConsumer: ({children}) => children(inset),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({x: 0, y: 0, width: 390, height: 844}),
  };
});

jest.mock('react-native-incall-manager', () => ({
  __esModule: true,
  default: {
    start: jest.fn(),
    stop: jest.fn(),
    setKeepScreenOn: jest.fn(),
    setForceSpeakerphoneOn: jest.fn(),
    chooseAudioRoute: jest.fn(() => Promise.resolve()),
    getIsWiredHeadsetPluggedIn: jest.fn(() => Promise.resolve(false)),
  },
}));

jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// react-native-webrtc — RTCView + media types referenced by call screens.
jest.mock('react-native-webrtc', () => ({
  __esModule: true,
  RTCView: 'RTCView',
  MediaStream: class {},
  mediaDevices: {getUserMedia: jest.fn(() => Promise.resolve({getTracks: () => []}))},
}));

// Keep-awake / status bar no-ops if pulled in transitively.
jest.mock(
  'expo-keep-awake',
  () => ({activateKeepAwakeAsync: jest.fn(), deactivateKeepAwake: jest.fn()}),
  {virtual: true},
);

// expo-linear-gradient ships ESM that jest doesn't transform; render it as a
// plain View in tests (preserves children + style).
jest.mock('expo-linear-gradient', () => {
  const {View} = require('react-native');
  return {LinearGradient: View};
});
