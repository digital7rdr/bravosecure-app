/**
 * Booking · Step 06 — Ops Room Review
 *
 * After the client submits their booking (DRAFT → PENDING_OPS), they
 * land here while the ops team decides. Spinning hourglass, booking
 * summary, locked CTA. Auto-advances on approval:
 *   - enough Bravo Credits → create booking + go straight to Confirmation
 *   - short on credits      → CreditPaywall (top-up → payment)
 * There is NO dedicated booking-flow payment screen — all payment
 * interaction is routed through the top-up module.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Animated, Easing, BackHandler,
  Modal, Pressable, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {useBookingStore} from '@store/bookingStore';
import {useWalletStore} from '@store/walletStore';
import {bookingApi} from '@services/api';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'OpsRoomReview'>;
type Rt  = RouteProp<BookingStackParamList, 'OpsRoomReview'>;
type StateKey = 'pending' | 'approved' | 'rejected';
type PayState = 'idle' | 'countdown' | 'paying' | 'paid' | 'insufficient' | 'error';

const POLL_EVERY_MS = 4000;
const COUNTDOWN_SECONDS = 5;
const PAID_HOLD_MS = 2200;

export default function OpsRoomReviewScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();

  const bookingId = route.params?.bookingId;
  const {draft, loadActiveBooking, activeBooking} = useBookingStore();
  const balance = useWalletStore(s => s.balance);
  const loadBalance = useWalletStore(s => s.loadBalance);

  const [state, setState] = useState<StateKey>('pending');
  const [payState, setPayState] = useState<PayState>('idle');
  const [countdown, setCountdown] = useState<number>(COUNTDOWN_SECONDS);
  const [payError, setPayError] = useState<string | null>(null);
  // Snapshot of balance BEFORE the debit, so the success screen can show
  // "Was 224 → −224 = 0" math even after `balance` updates.
  const [paidSnapshot, setPaidSnapshot] = useState<{before: number; charged: number; after: number} | null>(null);

  useEffect(() => { void loadBalance(); }, [loadBalance]);

  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 10_000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  // Real ops review — booking is already created (PENDING_OPS) by the
  // previous screen. We poll /bookings/:id every POLL_EVERY_MS and react
  // when ops flips the status to OPS_APPROVED or CANCELLED.
  const advancing = useRef(false);

  const advance = useCallback(async () => {
    if (advancing.current || !bookingId) {return;}
    advancing.current = true;
    setState('approved');
    await loadBalance();
    setCountdown(COUNTDOWN_SECONDS);
    setPayState('countdown');
  }, [bookingId, loadBalance]);

  // Cost is the booking's actual server-side total — works after cold
  // restart where the in-memory draft is empty.
  const chargeBc = Math.round(activeBooking?.total_eur ?? draft.estimated_price ?? 0);
  const haveBc = balance?.bravo_credits ?? 0;
  const afterBc = haveBc - chargeBc;

  // Audit fix 3.4 — clear the success-hold setTimeout on unmount.
  // The previous code fired-and-forgot, so navigating away during the
  // 1.6s celebration window (PAID_HOLD_MS) left a `navigation.replace`
  // pending after the screen tore down — RN Navigation logs a warning
  // and the replace silently no-ops on a stale reference.
  const paidHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (paidHoldTimer.current) {clearTimeout(paidHoldTimer.current);}
  }, []);

  // Audit fix — `runCharge` reads `chargeBc` and the pre/post balances
  // via store-getter so the callback identity stays stable. Previously
  // its deps included `haveBc` (a hook subscription), so every wallet
  // refresh re-built the function — and the countdown effect (which
  // lists `runCharge` in deps) reset its 1s timer mid-tick. Net effect:
  // the visible countdown could stall on the same number for as long
  // as the balance was refreshing. Keep deps minimal and use getState.
  const runCharge = useCallback(async () => {
    if (!bookingId) {return;}
    const before = useWalletStore.getState().balance?.bravo_credits ?? 0;
    const ab = useBookingStore.getState().activeBooking;
    const cost = Math.round(ab?.total_eur ?? 0);
    if (cost <= 0) {
      // Server-side total isn't in yet (cold restart, slow first poll).
      // Bail back to insufficient so the user isn't shown a "Deducting
      // 0 BC" sheet; the auto-retry effect will re-trigger once the
      // booking finishes loading.
      setPayState('insufficient');
      return;
    }
    setPayState('paying');
    setPayError(null);
    try {
      await bookingApi.payWithCredits(bookingId);
      await loadBalance();
      const after = useWalletStore.getState().balance?.bravo_credits ?? Math.max(0, before - cost);
      setPaidSnapshot({before, charged: cost, after});
      setPayState('paid');
      paidHoldTimer.current = setTimeout(() => {
        navigation.replace('BookingConfirmation', {
          bookingId,
          amountPaid: cost,
          currency: 'BC',
          paymentMethod: 'bravo_credits',
          creditsAwarded: 0,
        });
      }, PAID_HOLD_MS);
    } catch (e: unknown) {
      const err = e as {response?: {data?: {message?: string | string[]; code?: string}}; message?: string};
      const code  = err.response?.data?.code;
      const rawMsg = (Array.isArray(err.response?.data?.message)
        ? err.response?.data?.message?.join(' ')
        : err.response?.data?.message) ?? err.message ?? '';
      const isInsufficient =
        code === 'insufficient_credits' ||
        rawMsg === 'insufficient_credits' ||
        (typeof rawMsg === 'string' && rawMsg.includes('insufficient_credits'));
      // Server also rejects double-charge of an already-CONFIRMED
      // booking (lost-200 retry case): land on success rather than
      // showing PAYMENT FAILED. The booking is paid; just route on.
      const isAlreadyPaid =
        typeof rawMsg === 'string' && /already|state CONFIRMED|already_confirmed/i.test(rawMsg);
      if (isAlreadyPaid) {
        navigation.replace('BookingConfirmation', {
          bookingId,
          amountPaid: cost,
          currency: 'BC',
          paymentMethod: 'bravo_credits',
          creditsAwarded: 0,
        });
        return;
      }
      if (isInsufficient) {
        // Re-fetch balance before surfacing the insufficient state — a
        // delayed top-up settlement may have landed between the request
        // start and now, in which case the auto-retry effect will pick
        // it up immediately rather than the user re-tapping TOP UP NOW
        // and minting a second PaymentIntent.
        await loadBalance().catch(() => undefined);
        setPayState('insufficient');
      } else {
        setPayError(typeof rawMsg === 'string' && rawMsg ? rawMsg : 'Payment failed');
        setPayState('error');
      }
    }
  }, [bookingId, loadBalance, navigation]);

  // Countdown ticker — drives the auto-debit at 0.
  useEffect(() => {
    if (payState !== 'countdown') {return;}
    if (countdown <= 0) {
      void runCharge();
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [payState, countdown, runCharge]);

  // Auto-retry after a successful top-up. When the user comes back from
  // CreditPaywall (`payState` still 'insufficient') and the freshly-loaded
  // wallet now covers the charge, kick the debit again automatically so
  // they don't have to manually re-tap "TOP UP NOW".
  // Why: without this the modal stays stuck on the insufficient state
  // even though the wallet has the funds.
  useFocusEffect(
    useCallback(() => {
      void loadBalance();
    }, [loadBalance]),
  );
  useEffect(() => {
    if (payState !== 'insufficient') {return;}
    // Don't auto-retry until the server has confirmed the real charge
    // amount. Without this guard, a momentary `activeBooking === null`
    // race (the polling tick re-fetched) makes `chargeBc === 0` and
    // `haveBc >= 0` always true → countdown fires → server rejects with
    // a non-insufficient error → endless retry loop.
    if (!activeBooking) {return;}
    if (chargeBc <= 0) {return;}
    if (haveBc < chargeBc) {return;}
    setCountdown(COUNTDOWN_SECONDS);
    setPayState('countdown');
  }, [payState, haveBc, chargeBc, activeBooking]);

  // Audit fix 3.4 — declared up here so `lockBack` below can read it.
  // Set inside the polling effect when wall-clock exceeds HARD_CAP_MS.
  const [pollGaveUp, setPollGaveUp] = useState(false);

  // B-92 — the client must be able to WITHDRAW a request that ops hasn't
  // acted on (it can sit PENDING_OPS for days). Server-side this is always
  // allowed pre-commitment (booking.service cancel: PENDING_OPS is in the
  // pre-commitment list, idempotent if it already ended), so this is purely
  // the missing UI escape hatch on a screen that otherwise locks back.
  const [cancelling, setCancelling] = useState(false);
  const cancelRequest = useCallback(() => {
    if (!bookingId || cancelling) {return;}
    Alert.alert(
      'Cancel this request?',
      'Your booking will be withdrawn from ops review. Nothing has been charged.',
      [
        {text: 'Keep Waiting', style: 'cancel'},
        {
          text: 'Cancel Request',
          style: 'destructive',
          onPress: () => {
            setCancelling(true);
            // Stop the poll from racing us into approved/confirmed routing
            // while the cancel is in flight.
            advancing.current = true;
            useBookingStore.getState().cancelBooking(bookingId)
              .then(() => {
                navigation.popToTop();
              })
              .catch((e: unknown) => {
                advancing.current = false;
                setCancelling(false);
                const err = e as {response?: {data?: {message?: string | string[]}}; message?: string};
                const raw = err.response?.data?.message;
                const msg = Array.isArray(raw) ? raw.join(' · ') : raw ?? err.message ?? 'Could not cancel — try again.';
                Alert.alert('Cancel failed', msg);
              });
          },
        },
      ],
    );
  }, [bookingId, cancelling, navigation]);

  // Block hardware back / gesture while the booking is in-flight: ops
  // review pending OR auto-pay countdown / debit in progress. The user can
  // still switch tabs (Home/Messenger/Profile) via the bottom nav.
  // Audit fix 3.4 — once `pollGaveUp` is true (polling hit the 5-min cap)
  // release the lock so the user can navigate away to support / home.
  // Otherwise we'd be holding them on a screen we've stopped polling.
  const lockBack =
    !pollGaveUp && (
      state === 'pending' ||
      payState === 'countdown' ||
      payState === 'paying' ||
      payState === 'paid'
    );
  useFocusEffect(
    useCallback(() => {
      if (!lockBack) {return undefined;}
      navigation.setOptions({gestureEnabled: false});
      const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
      return () => {
        navigation.setOptions({gestureEnabled: true});
        sub.remove();
      };
    }, [navigation, lockBack]),
  );

  // Audit fix 3.4 — cap polling at 5 minutes total and surface a
  // "still waiting? contact support" affordance after that. Lowercase
  // status comparison (`.toUpperCase()` then exact match) was already
  // partly there — pin all four branches the same way so a backend
  // sending `confirmed` lowercase doesn't silently drop the user into
  // a stuck screen. Re-enable lockBack only while polling is healthy
  // (not after the cap), so a cap-hit user can navigate away.
  useEffect(() => {
    if (!bookingId) {return;}
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = POLL_EVERY_MS;
    const startedAt = Date.now();
    const HARD_CAP_MS = 5 * 60_000;
    const tick = async () => {
      try {
        await loadActiveBooking(bookingId);
        backoff = POLL_EVERY_MS;
      } catch {
        backoff = Math.min(backoff * 2, 30_000);
      }
      if (cancelled) {return;}
      const ab = useBookingStore.getState().activeBooking;
      // Audit fix 3.4 — normalize status case so a future change to
      // serializing it lowercase doesn't silently break the routing.
      const status = (ab?.status ?? '').toUpperCase();
      // Ops-gated auto dispatch: an AUTO booking parks here PENDING_OPS too, but its
      // approval hands it to the matchmaker (escrow-charged at accept) — it must never
      // enter the auto-pay countdown. 'now' flips to DISPATCHING moments after approval
      // (→ Finding screen); 'later' stays OPS_APPROVED until the cron starts the search.
      const isAuto = ab?.dispatch_mode === 'auto';
      if (status === 'DISPATCHING') {
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('FindingDetail', {bookingId});
          return;
        }
      } else if ((status === 'OPS_APPROVED' || status === 'PAYMENT_PENDING') && !isAuto) {
        void advance();
      } else if (status === 'CONFIRMED') {
        if (!advancing.current) {
          advancing.current = true;
          const total = ab?.total_eur ?? 0;
          navigation.replace('BookingConfirmation', {
            bookingId,
            amountPaid: Math.round(total),
            currency: 'BC',
            paymentMethod: 'bravo_credits',
            creditsAwarded: 0,
          });
          return;
        }
      } else if (status === 'LIVE') {
        if (!advancing.current) {
          advancing.current = true;
          navigation.replace('LiveTracking', {bookingId});
          return;
        }
      } else if (status === 'CANCELLED') {
        setState('rejected');
        return;
      }
      if (Date.now() - startedAt > HARD_CAP_MS) {
        setPollGaveUp(true);
        return;
      }
      timer = setTimeout(() => { void tick(); }, backoff);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) {clearTimeout(timer);}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const startIso = activeBooking?.start_time ?? draft.start_time;
  const whenLabel = useMemo(() => {
    if (!startIso) {return '—';}
    const d = new Date(startIso);
    // UTC so the time matches the backend/ops value on every device.
    return d.toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC'}) +
      ` · ${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}Z`;
  }, [startIso]);

  const service = draft.service === 'secure_transfer'
    ? 'Secure Transfer'
    : draft.service === 'executive_protection'
      ? 'Executive Protection'
      : draft.service === 'recon_team'
        ? 'Recon Team'
        : 'Emergency Extraction';

  const pickup = draft.pickup?.address ?? '—';
  const durationHours = activeBooking?.duration_hours ?? draft.duration_hours ?? 4;
  const totalRateBc = draft.estimated_price ?? activeBooking?.total_eur ?? 0;

  const rotate = spin.interpolate({inputRange: [0, 1], outputRange: ['0deg', '360deg']});

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={s.nav}>
        {state === 'pending' ? (
          <View style={s.back} />
        ) : (
          <TouchableOpacity style={s.back} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Icon name="chevron-left" size={18} color={Colors.textPrimary} />
          </TouchableOpacity>
        )}
        <Text style={s.navTitle}>OPS ROOM REVIEW</Text>
        <View style={[s.stepPill, state === 'approved' ? s.stepPillOk : state === 'rejected' ? s.stepPillErr : s.stepPillWarn]}>
          <Text style={[s.stepPillText, state === 'approved' ? s.stepPillTextOk : state === 'rejected' ? s.stepPillTextErr : s.stepPillTextWarn]}>
            {state === 'approved' ? 'Approved' : state === 'rejected' ? 'Rejected' : 'Pending'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingBottom: 20, gap: 12, paddingTop: 4}}
        showsVerticalScrollIndicator={false}>

        {/* Audit fix 3.4 — polling capped at 5 min. Show a clean "still
            waiting?" message instead of letting the spinner animate forever. */}
        {pollGaveUp && state === 'pending' && (
          <View style={[s.reviewHero, {borderColor: Colors.warning}]}>
            <Text style={[s.navTitle, {color: Colors.warning, marginBottom: 6}]}>
              Still waiting?
            </Text>
            <Text style={{color: Colors.textPrimary, fontSize: 13, lineHeight: 18}}>
              Auto-refresh paused after 5 minutes. Ops review can take longer
              during peak hours — contact support if your booking still
              shows pending.
            </Text>
          </View>
        )}

        {/* Hourglass hero */}
        <View style={s.reviewHero}>
          <View style={s.heroTopLine} />
          <View style={s.hourglass}>
            <Animated.View style={[s.hourglassRing, {transform: [{rotate}]}]} />
            <Icon name="timer-sand" size={36} color={Colors.warning} />
          </View>
          <Text style={s.heroTitle}>AWAITING OPS APPROVAL</Text>
          <Text style={s.heroDesc}>
            Your booking is being reviewed by the operations team. Typically{' '}
            <Text style={s.heroDescB}>2–5 minutes</Text>.
          </Text>

          {/* B-92 — escape hatch while the request sits in the ops queue. */}
          {state === 'pending' && (
            <TouchableOpacity
              style={[s.cancelBtn, cancelling && {opacity: 0.55}]}
              activeOpacity={0.8}
              disabled={cancelling}
              accessibilityRole="button"
              accessibilityLabel="Cancel this request"
              onPress={cancelRequest}>
              {cancelling ? (
                <ActivityIndicator size="small" color="#FF8B8B" />
              ) : (
                <>
                  <Icon name="close-circle-outline" size={16} color="#FF8B8B" />
                  <Text style={s.cancelBtnText}>CANCEL REQUEST</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Summary */}
        <View style={s.sumBox}>
          <Text style={s.sumHd}>BOOKING SUMMARY</Text>
          <SumRow k="Service" v={service + (draft.selected_add_ons?.length ? ` + ${draft.selected_add_ons.length} add-ons` : '')} />
          <SumRow k="Date" v={whenLabel} />
          <SumRow k="Pick-up" v={pickup} />
          <SumRow k="Duration" v={`${durationHours} hrs est.`} />
          <SumRow k="Total Rate" v={`${totalRateBc.toLocaleString()} BC`} highlight />
        </View>

        {/* Status tri-state */}
        <View style={s.statusRow}>
          {(['pending', 'approved', 'rejected'] as StateKey[]).map(k => (
            <View
              key={k}
              style={[
                s.statusBtn,
                state === k && (k === 'approved' ? s.statusBtnOk : k === 'rejected' ? s.statusBtnErr : s.statusBtnWarn),
              ]}>
              <Text
                style={[
                  s.statusBtnText,
                  state === k && (k === 'approved' ? s.statusTextOk : k === 'rejected' ? s.statusTextErr : s.statusTextWarn),
                ]}>
                {k === 'pending' ? 'Pending' : k === 'approved' ? 'Approved' : 'Rejected'}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* CTA — locked while pending, actionable on rejected */}
      <View style={[s.ctaWrap, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}>
        {state === 'rejected' ? (
          <TouchableOpacity
            style={[s.ctaLocked, {backgroundColor: Colors.danger, borderColor: Colors.danger}]}
            onPress={() => navigation.popToTop()}
            activeOpacity={0.85}>
            <Icon name="close-circle-outline" size={14} color="#fff" />
            <Text style={[s.ctaLockedText, {color: '#fff'}]}>BOOKING REJECTED · TAP TO RESTART</Text>
          </TouchableOpacity>
        ) : (
          <View style={s.ctaLocked}>
            <Icon name="clock-outline" size={14} color={Colors.textPrimary} />
            <Text style={s.ctaLockedText}>WAITING FOR OPS ROOM</Text>
          </View>
        )}
      </View>

      <Modal
        visible={payState !== 'idle'}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => { /* gated below by payState */ }}>
        <View style={s.sheetBg}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { /* dismiss disabled */ }} />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            {(payState === 'countdown' || payState === 'paying') && (
              <>
                <View style={s.sheetIconWrap}>
                  {payState === 'paying'
                    ? <ActivityIndicator size="large" color={Colors.primary} />
                    : <Text style={s.countdownNum}>{countdown}</Text>}
                </View>
                <Text style={s.sheetTitle}>AUTO-PAYING WITH BRAVO CREDITS</Text>
                <Text style={s.sheetSub}>
                  {payState === 'paying'
                    ? 'Charging your wallet…'
                    : `Charging in ${countdown}s · cancel to pay later`}
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="YOU HAVE"     v={`${haveBc.toLocaleString()} BC`} />
                  <PayRow k="DEDUCTING"    v={`− ${chargeBc.toLocaleString()} BC`} accent />
                  <View style={s.mathDivider} />
                  <PayRow k="REMAINING"    v={`${Math.max(0, afterBc).toLocaleString()} BC`} bold big />
                </View>
                <TouchableOpacity
                  style={[s.sheetBtnGhost, payState === 'paying' && {opacity: 0.4}]}
                  disabled={payState === 'paying'}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>CANCEL · I'LL PAY LATER</Text>
                </TouchableOpacity>
              </>
            )}

            {payState === 'paid' && paidSnapshot && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(0,200,83,0.15)'}]}>
                  <Icon name="check-bold" size={40} color={Colors.success} />
                </View>
                <Text style={[s.sheetTitle, {color: Colors.success}]}>PAYMENT CAPTURED</Text>
                <Text style={s.sheetSub}>
                  Booking confirmed · sending you to the dashboard.
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="WAS"        v={`${paidSnapshot.before.toLocaleString()} BC`} />
                  <PayRow k="DEDUCTED"   v={`− ${paidSnapshot.charged.toLocaleString()} BC`} accent />
                  <View style={s.mathDivider} />
                  <PayRow k="NEW BALANCE" v={`${paidSnapshot.after.toLocaleString()} BC`} bold big />
                </View>
              </>
            )}

            {payState === 'insufficient' && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(255,193,7,0.12)'}]}>
                  <Icon name="alert-circle-outline" size={36} color={Colors.warning} />
                </View>
                <Text style={s.sheetTitle}>INSUFFICIENT BRAVO CREDITS</Text>
                <Text style={s.sheetSub}>
                  Top up to confirm your booking. We'll keep it reserved as{' '}
                  <Text style={{color: Colors.warning, fontWeight: '700'}}>Payment Pending</Text>.
                </Text>
                <View style={s.mathBox}>
                  <PayRow k="You have"  v={`${haveBc.toLocaleString()} BC`} />
                  <PayRow k="Need"      v={`${chargeBc.toLocaleString()} BC`} />
                  <View style={s.mathDivider} />
                  <PayRow k="Short"     v={`${Math.max(0, chargeBc - haveBc).toLocaleString()} BC`} bold accent />
                </View>
                <TouchableOpacity
                  style={s.sheetBtnPrimary}
                  onPress={() => {
                    if (!bookingId) {return;}
                    // Use push (not replace) so returning from the paywall
                    // lands the user back on OpsRoomReview with `payState`
                    // still set to 'insufficient'; the balance-watch effect
                    // below auto-retries the charge once the wallet covers
                    // the cost.
                    navigation.navigate('CreditPaywall', {
                      bookingId,
                      source: 'opsroom',
                      amountDue: chargeBc,
                    });
                  }}
                  activeOpacity={0.85}>
                  <Icon name="wallet-plus-outline" size={16} color="#fff" />
                  <Text style={s.sheetBtnPrimaryText}>TOP UP NOW</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.sheetBtnGhost}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>I'LL TOP UP LATER</Text>
                </TouchableOpacity>
              </>
            )}

            {payState === 'error' && (
              <>
                <View style={[s.sheetIconWrap, {backgroundColor: 'rgba(244,67,54,0.12)'}]}>
                  <Icon name="alert-octagon-outline" size={36} color={Colors.danger} />
                </View>
                <Text style={s.sheetTitle}>PAYMENT FAILED</Text>
                <Text style={s.sheetSub}>{payError ?? 'Could not charge your wallet. Please retry.'}</Text>
                <TouchableOpacity
                  style={s.sheetBtnPrimary}
                  onPress={() => { setCountdown(COUNTDOWN_SECONDS); setPayState('countdown'); }}
                  activeOpacity={0.85}>
                  <Icon name="refresh" size={16} color="#fff" />
                  <Text style={s.sheetBtnPrimaryText}>RETRY</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.sheetBtnGhost}
                  onPress={() => setPayState('idle')}
                  activeOpacity={0.8}>
                  <Text style={s.sheetBtnGhostText}>CLOSE</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function PayRow({k, v, bold, big, accent}: {k: string; v: string; bold?: boolean; big?: boolean; accent?: boolean}) {
  return (
    <View style={s.payRow}>
      <Text style={s.payK}>{k}</Text>
      <Text style={[s.payV, bold && s.payVBold, big && s.payVBig, accent && {color: Colors.warning}]}>{v}</Text>
    </View>
  );
}

function SumRow({k, v, highlight}: {k: string; v: string; highlight?: boolean}) {
  return (
    <View style={s.sumRow}>
      <Text style={s.sumK}>{k}</Text>
      <Text style={[s.sumV, highlight && s.sumVAcc]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  nav: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  back: {
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  navTitle: {
    flex: 1,
    fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 1.5,
    color: Colors.textPrimary,
  },
  stepPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1,
    backgroundColor: Colors.surfaceElevated,
  },
  stepPillWarn: {borderColor: Colors.warning},
  stepPillOk:   {borderColor: Colors.success},
  stepPillErr:  {borderColor: Colors.danger},
  stepPillText: {fontSize: 10, fontWeight: '700', letterSpacing: 1.2},
  stepPillTextWarn: {color: Colors.warning},
  stepPillTextOk:   {color: Colors.success},
  stepPillTextErr:  {color: Colors.danger},

  scroll: {flex: 1, paddingHorizontal: 16},

  reviewHero: {
    padding: 20, borderRadius: 12,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', overflow: 'hidden', position: 'relative',
  },
  heroTopLine: {
    position: 'absolute', top: 0, left: '15%', right: '15%', height: 1,
    backgroundColor: Colors.warning, opacity: 0.7,
  },
  hourglass: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: 'rgba(255,193,7,0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  hourglassRing: {
    position: 'absolute', width: 76, height: 76, borderRadius: 38,
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.35)',
    borderStyle: 'dashed',
  },
  heroTitle: {
    fontFamily: BravoFont.bold, fontSize: 13, letterSpacing: 1.2,
    color: Colors.textPrimary, marginBottom: 6,
  },
  heroDesc: {
    fontSize: 12, color: Colors.textSecondary,
    lineHeight: 17, textAlign: 'center', paddingHorizontal: 8,
  },
  heroDescB: {color: Colors.warning, fontWeight: '700'},
  cancelBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    alignSelf: 'stretch', height: 44, borderRadius: 12, marginTop: 16,
    backgroundColor: 'rgba(255,93,93,0.08)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.3)',
  },
  cancelBtnText: {color: '#FF8B8B', fontSize: 11.5, fontWeight: '800', letterSpacing: 1.6},

  sumBox: {
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  sumHd: {
    fontFamily: BravoFont.semiBold, fontSize: 10,
    color: Colors.textMuted, letterSpacing: 1.5, marginBottom: 10,
  },
  sumRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 10,
    paddingVertical: 7,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
  },
  sumK: {
    fontFamily: BravoFont.medium, fontSize: 12,
    color: Colors.textMuted,
  },
  sumV: {
    flex: 1, textAlign: 'right',
    fontFamily: BravoFont.bold, fontSize: 11.5,
    color: Colors.textPrimary, letterSpacing: 0.2,
  },
  sumVAcc: {color: Colors.accent},

  statusRow: {
    flexDirection: 'row', gap: 8, marginTop: 4,
  },
  statusBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
  },
  statusBtnWarn: {backgroundColor: 'rgba(255,193,7,0.12)', borderColor: Colors.warning},
  statusBtnOk:   {backgroundColor: 'rgba(0,200,83,0.12)',  borderColor: Colors.success},
  statusBtnErr:  {backgroundColor: 'rgba(213,0,0,0.12)',   borderColor: Colors.danger},
  statusBtnText: {
    fontFamily: BravoFont.bold, fontSize: 10.5, letterSpacing: 1.2,
    color: Colors.textMuted,
  },
  statusTextWarn: {color: Colors.warning},
  statusTextOk:   {color: Colors.success},
  statusTextErr:  {color: Colors.danger},

  ctaWrap: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    backgroundColor: Colors.background,
  },
  ctaLocked: {
    height: 48, borderRadius: 8,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.borderDefault,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaLockedText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: Colors.textPrimary,
    letterSpacing: 1.2,
  },

  // Auto-pay countdown sheet
  sheetBg: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: Colors.surfaceBorder,
    alignItems: 'center', gap: 12,
  },
  sheetHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.borderDefault, marginBottom: 8,
  },
  sheetIconWrap: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(37,99,235,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  countdownNum: {
    fontFamily: BravoFont.bold, fontSize: 40,
    color: Colors.primary, letterSpacing: -1,
  },
  sheetTitle: {
    fontFamily: BravoFont.bold, fontSize: 13, letterSpacing: 1.4,
    color: Colors.textPrimary, marginTop: 4, textAlign: 'center',
  },
  sheetSub: {
    fontSize: 12, color: Colors.textSecondary,
    lineHeight: 17, textAlign: 'center', paddingHorizontal: 4,
  },

  mathBox: {
    width: '100%',
    padding: 14, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    gap: 8, marginTop: 4,
  },
  mathDivider: {height: 1, backgroundColor: Colors.surfaceBorder, marginVertical: 2},
  payRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  payK: {fontSize: 11, color: Colors.textMuted, letterSpacing: 1.2, fontWeight: '700'},
  payV: {fontSize: 15, color: Colors.textPrimary, fontWeight: '700'},
  payVBold: {fontFamily: BravoFont.bold},
  payVBig: {fontSize: 22, color: Colors.success, letterSpacing: -0.3},

  sheetBtnPrimary: {
    width: '100%', height: 48, borderRadius: 10,
    backgroundColor: Colors.primary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 6,
  },
  sheetBtnPrimaryText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, color: '#fff',
    letterSpacing: 1.2,
  },
  sheetBtnGhost: {
    width: '100%', height: 44, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetBtnGhostText: {
    fontFamily: BravoFont.semiBold, fontSize: 11.5,
    color: Colors.textMuted, letterSpacing: 1.2,
  },
}));
