import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Colors} from '@theme/index';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {PRO_MONTHLY_BC} from '@utils/tier';
import {useAuthStore} from '@store/authStore';
import {subscriptionApi} from '@services/api';
import {useWalletStore} from '@store/walletStore';
import {usePaymentFlow} from '@services/stripe';
import {bcToUsd} from '../booking/creditMath';
import {outcomeForSubscribeError} from './proPaywallFlow';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ProPaywall'>;
type Rt = RouteProp<BookingStackParamList, 'ProPaywall'>;

type IconName = React.ComponentProps<typeof Icon>['name'];

// What unlocks once Pro is active. M1A: Department Channels moved to
// ENTERPRISE — do not promise it here; the Enterprise upsell lives in
// Settings → Pricing.
const PRO_FEATURES: {icon: IconName; label: string; sub: string}[] = [
  {icon: 'cloud-lock', label: 'Secure Cloud Vault', sub: '100MB free encrypted cloud storage'},
  {icon: 'calendar-clock', label: 'AI Itinerary booking', sub: 'Smart scheduling + risk-aware routing'},
  {icon: 'shield-account', label: 'Full security suite', sub: 'Ops room, retainers, advanced reports'},
];

export default function ProPaywallScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const insets = useSafeAreaInsets();

  // Where to go after Pro is active. Defaults to popping back to the screen
  // that opened the paywall (e.g. DepartmentChannels re-renders unlocked).
  const returnTo = route.params?.returnTo;

  const subscribeToPro = useAuthStore(s => s.subscribeToPro);
  const {balance, loadBalance} = useWalletStore();
  const {topUpAndCharge} = usePaymentFlow();

  const [phase, setPhase] = useState<'idle' | 'subscribing' | 'topup' | 'done'>('idle');
  const [autoRenew, setAutoRenew] = useState(true);
  // S9 — live ops-editable price; compiled constant as offline fallback.
  const [price, setPrice] = useState(PRO_MONTHLY_BC);
  const currentBalance = balance?.bravo_credits ?? 0;
  const shortfall = Math.max(0, price - currentBalance);

  useEffect(() => {
    void loadBalance();
    let alive = true;
    subscriptionApi.getPrices()
      .then(({data}) => { if (alive && data?.pro > 0) {setPrice(data.pro);} })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [loadBalance]);

  const finish = useCallback(() => {
    setPhase('done');
    if (returnTo) {
      navigation.navigate(returnTo as never);
    } else {
      navigation.goBack();
    }
  }, [navigation, returnTo]);

  // Failure fallback: payment/subscribe failed → the user remains on Bravo
  // Lite (Lite is included for everyone). The tier is only ever flipped by
  // a resolved subscribeToPro(), so there's nothing to undo — we just reset
  // the screen and tell the user they're still on Lite.
  const stayOnLite = useCallback((title: string, message: string) => {
    setPhase('idle');
    Alert.alert(title, message);
  }, []);

  // Core flow: try to subscribe (server debits BC). On insufficient_credits,
  // top up the shortfall via Stripe, then retry the subscribe once.
  const handleSubscribe = useCallback(async () => {
    if (phase === 'subscribing' || phase === 'topup') {return;}
    setPhase('subscribing');
    try {
      await subscribeToPro(autoRenew);
      finish();
    } catch (e) {
      const outcome = outcomeForSubscribeError(e);
      if (outcome.kind === 'stay-on-lite') {
        // Subscribe rejected for some other reason — tier was never flipped
        // server-side, so the user stays on Lite. Surface + reset.
        stayOnLite('Subscription failed', outcome.reason);
        return;
      }
      // Not enough BC — top up the shortfall, then retry the subscribe.
      setPhase('topup');
      try {
        const {charged} = await topUpAndCharge({
          amountFiat: +(bcToUsd(shortfall)).toFixed(2),
          currency: 'usd',
        });
        if (!charged) {
          setPhase('idle');   // user cancelled PaymentSheet — silent, stays Lite
          return;
        }
        await loadBalance().catch(() => undefined);
        await subscribeToPro(autoRenew);   // retry now that BC covers the price
        finish();
      } catch (topupErr) {
        // Payment failed → fall back to Lite. The card was not charged for
        // Pro (or the BC debit never ran), so subscription_tier is still
        // 'lite' both locally and server-side. Make that explicit.
        stayOnLite(
          'Payment failed',
          topupErr instanceof Error ? topupErr.message : 'We could not complete the payment. You are still on Bravo Lite.',
        );
      }
    }
  }, [phase, subscribeToPro, finish, topUpAndCharge, shortfall, loadBalance, stayOnLite, autoRenew]);

  const busy = phase === 'subscribing' || phase === 'topup';
  const busyLabel = phase === 'topup' ? 'Processing payment…' : 'Activating Pro…';

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7} disabled={busy}>
          <Icon name="arrow-left" size={20} color="#CBD5E1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Bravo Pro</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 120}]}>

        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Icon name="shield-star" size={36} color="#FFF" />
          </View>
          <Text style={styles.heroTitle}>Upgrade to Bravo Pro</Text>
          <Text style={styles.heroSub}>
            Unlock your Secure Cloud Vault and the full security suite. Everything in Lite stays included.
          </Text>
        </View>

        {/* Price card */}
        <View style={styles.priceCard}>
          <View style={styles.priceRow}>
            <Icon name="star-four-points" size={22} color="#FBBF24" />
            <Text style={styles.priceValue}>{price.toLocaleString()}</Text>
            <Text style={styles.priceUnit}>BC<Text style={styles.pricePeriod}> / month</Text></Text>
          </View>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Your balance</Text>
            <Text style={[styles.balanceVal, shortfall > 0 && {color: '#F59E0B'}]}>
              {currentBalance.toLocaleString()} BC
            </Text>
          </View>
          {shortfall > 0 && (
            <View style={styles.shortfallNote}>
              <Icon name="information-outline" size={13} color="#F59E0B" />
              <Text style={styles.shortfallText}>
                You need {shortfall.toLocaleString()} more BC. We'll top up the difference
                ({shortfall.toLocaleString()} BC) via card, then activate Pro.
              </Text>
            </View>
          )}
        </View>

        {/* Features */}
        <Text style={styles.sectionLabel}>What's included</Text>
        {PRO_FEATURES.map(f => (
          <View key={f.label} style={styles.featureRow}>
            <View style={styles.featureIcon}>
              <Icon name={f.icon} size={18} color={Colors.primary} />
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.featureLabel}>{f.label}</Text>
              <Text style={styles.featureSub}>{f.sub}</Text>
            </View>
            <Icon name="check-circle" size={18} color="#34d399" />
          </View>
        ))}

        {/* Auto-renew toggle */}
        <TouchableOpacity
          style={styles.renewRow}
          activeOpacity={0.8}
          onPress={() => setAutoRenew(v => !v)}
          disabled={busy}>
          <View style={{flex: 1}}>
            <Text style={styles.renewLabel}>Auto-renew monthly</Text>
            <Text style={styles.renewSub}>Charge my card every 30 days so Pro never lapses. Cancel anytime.</Text>
          </View>
          <View style={[styles.toggle, autoRenew && styles.toggleOn]}>
            <View style={[styles.toggleThumb, autoRenew && styles.toggleThumbOn]} />
          </View>
        </TouchableOpacity>

        <View style={styles.secureRow}>
          <Icon name="lock" size={12} color="#475569" />
          <Text style={styles.secureText}>
            Charged in Bravo Credits. Card top-up (if needed) secured by Stripe.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, {paddingBottom: insets.bottom + 14}]}>
        <TouchableOpacity
          style={[styles.cta, busy && {opacity: 0.7}]}
          onPress={() => { void handleSubscribe(); }}
          disabled={busy}
          activeOpacity={0.85}>
          {busy ? (
            <>
              <ActivityIndicator color="#FFF" />
              <Text style={styles.ctaText}>{busyLabel}</Text>
            </>
          ) : (
            <>
              <Icon name="shield-star" size={18} color="#FFF" />
              <Text style={styles.ctaText}>
                {shortfall > 0 ? 'Top up & Subscribe' : `Subscribe · ${price.toLocaleString()} BC`}
              </Text>
            </>
          )}
        </TouchableOpacity>
        <Text style={styles.footerHint}>Renews every 30 days. Cancel anytime.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 14, fontWeight: '800', color: '#F1F5F9', letterSpacing: 0.5},

  scroll: {padding: 16, gap: 14},

  hero: {alignItems: 'center', gap: 10, paddingTop: 8},
  heroIcon: {width: 72, height: 72, borderRadius: 22, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center', shadowColor: Colors.primary, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: {width: 0, height: 6}, elevation: 6},
  heroTitle: {fontSize: 22, fontWeight: '800', color: '#F1F5F9'},
  heroSub: {fontSize: 13, color: '#94A3B8', textAlign: 'center', lineHeight: 19, paddingHorizontal: 12},

  priceCard: {backgroundColor: '#0D1929', borderRadius: 18, padding: 18, borderWidth: 1, borderColor: '#1E2D45', gap: 12},
  priceRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8},
  priceValue: {fontSize: 34, fontWeight: '800', color: '#F1F5F9', letterSpacing: -1},
  priceUnit: {fontSize: 16, fontWeight: '700', color: '#94A3B8', marginBottom: 5},
  pricePeriod: {fontSize: 13, fontWeight: '600', color: '#64748B'},
  balanceRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#1E2D45', paddingTop: 12},
  balanceLabel: {fontSize: 12, color: '#94A3B8'},
  balanceVal: {fontSize: 14, fontWeight: '700', color: '#34d399'},
  shortfallNote: {flexDirection: 'row', gap: 8, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 10, padding: 10},
  shortfallText: {flex: 1, fontSize: 11, color: '#F59E0B', lineHeight: 16},

  sectionLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#64748B', marginTop: 4},
  featureRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14, padding: 14},
  featureIcon: {width: 36, height: 36, borderRadius: 11, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.22)', alignItems: 'center', justifyContent: 'center'},
  featureLabel: {fontSize: 13, fontWeight: '700', color: '#F1F5F9'},
  featureSub: {fontSize: 11, color: '#64748B', marginTop: 2},

  renewRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14, padding: 14, marginTop: 4},
  renewLabel: {fontSize: 13, fontWeight: '700', color: '#F1F5F9'},
  renewSub: {fontSize: 11, color: '#64748B', marginTop: 2, lineHeight: 15},
  toggle: {width: 44, height: 26, borderRadius: 13, backgroundColor: '#1E2D45', justifyContent: 'center', paddingHorizontal: 3},
  toggleOn: {backgroundColor: Colors.primary},
  toggleThumb: {width: 20, height: 20, borderRadius: 10, backgroundColor: '#64748B'},
  toggleThumbOn: {backgroundColor: '#FFF', marginLeft: 18},

  secureRow: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, marginTop: 4},
  secureText: {flex: 1, fontSize: 10.5, color: '#475569', lineHeight: 15},

  footer: {paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1E2D45', backgroundColor: Colors.background},
  cta: {backgroundColor: Colors.primary, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: Colors.primary, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: {width: 0, height: 4}, elevation: 5},
  ctaText: {fontSize: 14, fontWeight: '800', color: '#FFF', letterSpacing: 0.5},
  footerHint: {textAlign: 'center', fontSize: 10, color: '#475569', marginTop: 8},
}));
