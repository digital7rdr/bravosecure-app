/**
 * Metro bundler config — customizes the Expo default.
 *
 * Why this exists: `jose` (used for Ed25519 sender-cert verification
 * in src/modules/messenger/crypto/senderCert.ts) ships separate Node
 * and browser builds via conditional exports. Without this config,
 * Metro resolves the Node build which imports `node:buffer` and
 * crashes the RN bundler.
 *
 * Flipping on `unstable_enablePackageExports` + setting the condition
 * priority to `['react-native', 'browser', ...]` forces jose (and any
 * other package with similar exports) to resolve to the browser-safe
 * path that uses standard `Uint8Array` + WebCrypto.
 */

const {getDefaultConfig} = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver = {
  ...config.resolver,
  unstable_enablePackageExports: true,
  unstable_conditionNames: ['react-native', 'browser', 'require'],
};

module.exports = config;
