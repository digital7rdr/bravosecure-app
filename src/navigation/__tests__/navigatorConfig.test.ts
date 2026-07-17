import * as fs from 'fs';
import * as path from 'path';

/**
 * B-85 / MX-13 — static config locks (same pattern as the logAudit
 * source-audit test). Rendering the navigators in Jest would pull the
 * entire screen tree (mediasoup, notifee, …), so we lock the two
 * navigation invariants at the source level instead:
 *
 *   1. MessengerNavigator MUST declare initialRouteName="MessengerHome".
 *      Without it a cold deep-link (notification tap → Main→MessengerTab→
 *      Chat while the lazy tab was never mounted) seeds the stack as
 *      [Chat] alone; back then bubbles to the tab navigator's
 *      backBehavior="history" and lands on the Dashboard.
 *   2. AgentNavigator's Chat route carries the chat polish options.
 */

const NAV_DIR = path.resolve(__dirname, '..');

function readSource(file: string): string {
  return fs.readFileSync(path.join(NAV_DIR, file), 'utf8');
}

describe('B-85 — messenger stack seeds MessengerHome under deep-linked screens', () => {
  it('MessengerNavigator declares initialRouteName="MessengerHome"', () => {
    const src = readSource('MessengerNavigator.tsx');
    expect(src).toMatch(/<Stack\.Navigator[\s\S]{0,600}initialRouteName="MessengerHome"/);
  });

  it('MessengerHome and Chat stay registered in the same stack', () => {
    const src = readSource('MessengerNavigator.tsx');
    expect(src).toContain('name="MessengerHome"');
    expect(src).toContain('name="Chat"');
  });

  // The prop alone is NOT enough: a nested navigate that carries a
  // `screen` param OVERRIDES initialRouteName on first mount unless the
  // call passes `initial: false` (verified against
  // @react-navigation/core useNavigationBuilder). Lock every deep-link
  // site that targets Chat through the lazy MessengerTab.
  it('every Chat deep-link passes initial: false so MessengerHome seeds beneath it', () => {
    const fcm = fs.readFileSync(
      path.resolve(NAV_DIR, '..', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8');
    const chatNavs = fcm.match(/screen: 'Chat',[^}]*/g) ?? [];
    expect(chatNavs.length).toBeGreaterThanOrEqual(2);
    for (const site of chatNavs) {
      expect(site).toContain('initial: false');
    }
    const ops = fs.readFileSync(
      path.resolve(NAV_DIR, '..', 'screens', 'ops', 'OpsMissionDetailScreen.tsx'), 'utf8');
    expect(ops).toMatch(/screen:\s*'Chat',\s*\n\s*initial:\s*false/);
  });
});

describe('MX-13 — agency-shell Chat route mirrors messenger chat polish', () => {
  it('AgentNavigator Chat route sets freezeOnBlur + native slide', () => {
    const src = readSource('AgentNavigator.tsx');
    const chatLine = src.split('\n').find(l => l.includes('name="Chat"'));
    expect(chatLine).toBeDefined();
    expect(chatLine).toContain('freezeOnBlur: true');
    expect(chatLine).toContain("animation: 'slide_from_right'");
  });
});

describe('B-95 — product switch actually swaps the tab tree + back reopens the gate', () => {
  // A keyed remount alone REHYDRATES the old product's nested state from the
  // parent 'Main' route (all products share route names), so MainNavigator
  // must hold one navigator-free frame per switch to let the library's
  // deferred state cleanup run. Losing either half silently regresses to the
  // "header switches but the screen stays" bug.
  it('MainNavigator holds a navigator-free frame while mountedProduct lags activeProduct', () => {
    const src = readSource('MainNavigator.tsx');
    expect(src).toMatch(/setMountedProduct\(activeProduct\)/);
    const holdMatch = /mountedProduct !== activeProduct\) \{\r?\n\s*return <View/.exec(src);
    const navIdx = src.indexOf('<Tab.Navigator');
    expect(holdMatch).not.toBeNull();
    expect(navIdx).toBeGreaterThan(holdMatch!.index);
  });

  it('MainNavigator keeps the keyed remount + per-product initial route', () => {
    const src = readSource('MainNavigator.tsx');
    expect(src).toMatch(/key=\{activeProduct\}/);
    expect(src).toMatch(/initialRouteName=\{activeProduct === 'messenger' \? 'MessengerTab' : 'SecureTab'\}/);
  });

  it('hardware back at a product root requests the gate instead of exiting', () => {
    const src = readSource('MainNavigator.tsx');
    const handler = src.match(/hardwareBackPress[\s\S]{0,400}/)?.[0] ?? '';
    expect(handler).toContain('navigationRef.canGoBack()');
    expect(handler).toContain('requestGate()');
  });

  it('the gate renders for gateVisible, not only for a missing product', () => {
    const src = readSource('MainNavigator.tsx');
    expect(src).toMatch(/!activeProduct \|\| gateVisible/);
  });
});

describe('B-98 — back controls exist and survive an empty stack', () => {
  const SCREENS = path.resolve(NAV_DIR, '..', 'screens');
  const read = (rel: string) =>
    fs.readFileSync(path.join(SCREENS, rel), 'utf8');

  // B-98a — the wizard is replace-entered on resume (AgentTypeSelect status
  // jump) and by the KYC advance, so a plain goBack() silently no-ops. Every
  // wizard back site must guard with canGoBack and fall back via prevStepFor.
  it.each([
    'agent/AgentKYCScreen.tsx',
    'agent/AgentCoverageScreen.tsx',
    'agent/AgentAvailabilityScreen.tsx',
    'agent/AgentDocsUploadScreen.tsx',
  ])('%s guards back with canGoBack + prevStepFor fallback', rel => {
    const src = read(rel);
    expect(src).toMatch(/navigation\.canGoBack\(\)/);
    expect(src).toMatch(/prevStepFor\(/);
    expect(src).toContain('onBack={handleBack}');
  });

  it('AgentRegistrationWizard steps back internally, hides the chevron on an empty stack', () => {
    const src = read('agent/AgentRegistrationWizardScreen.tsx');
    expect(src).toMatch(/stepIndex > 0\s*\n?\s*\? \(?\) => setStep\(STEPS\[stepIndex - 1\]\.id\)/);
    expect(src).toMatch(/canPop \? \(\) => navigation\.goBack\(\) : undefined/);
  });

  it('NavHeader renders a spacer (not a dead chevron) when onBack is absent', () => {
    const src = read('agent/_shared.tsx');
    expect(src).toMatch(/\{onBack \? \(/);
    expect(src).toMatch(/<View style=\{nav\.back\} \/>/);
  });

  // B-98b — pushed screens that shipped with no visible back control.
  it.each([
    ['news/NewsFeedScreen.tsx',              /accessibilityLabel="Go back"/],
    ['messenger/FileVaultPurchaseScreen.tsx', /accessibilityLabel="Go back"/],
    ['liveops/LiveTrackingScreen.tsx',        /accessibilityLabel="Go back"/],
  ])('%s has a visible back control wired to goBack', (rel, marker) => {
    const src = read(rel as string);
    expect(src).toMatch(marker as RegExp);
    expect(src).toMatch(/navigation\.goBack\(\)/);
  });
});
