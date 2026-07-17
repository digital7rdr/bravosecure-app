/**
 * Booking · Step 05 — Team & Add-ons
 *
 * Premium redesign (Bravo "Team Add-ons" design handoff): obsidian/cobalt
 * palette matching the rest of the booking flow. Team composition steppers
 * (CPOs, Vehicles), a "Driver Only (Client Vehicle)" toggle, a Control-Room
 * approval notice, and optional add-on rows with live +BC/hr pricing. A rate
 * bar shows the live BC/hr total; CTA submits for Ops review.
 *
 * Pricing mirrors the server (pricing.ts → pricing.service.ts): 86 BC base,
 * +25% per extra CPO/vehicle, 0.65× driver-only. Driver-only means the client
 * supplies the vehicle — Bravo dispatches a security driver but no Bravo
 * vehicle, so the vehicle stepper is locked to "Client vehicle".
 */
import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {bookingApi} from '@services/api';
import {rateBcPerHour, vehiclesForPassengers, maxCposForClientVehicle, MAX_CPOS} from './pricing';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'CustomizeAddOns'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

// Design tokens (Bravo "Team Add-ons" handoff — obsidian/cobalt premium).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

interface AddOnDef {
  key: string;
  title: string;
  desc: string;
  icon: IconName;
  /** Per-hour price in BC (1:1 with EUR in Phase 1). */
  priceHourly: number;
}

const ADDONS: AddOnDef[] = [
  {key: 'female_cpo', title: 'Female CPO Team', desc: 'Female close protection officer(s)', icon: 'account',       priceHourly: 120},
  {key: 'recon',      title: 'Recon Team',      desc: 'Area sweep & route assessment',      icon: 'radar',         priceHourly: 100},
  {key: 'medical',    title: 'Medical Support', desc: 'Paramedic on standby',               icon: 'medical-bag',   priceHourly:  90},
  {key: 'comms',      title: 'Comms / SIGINT',  desc: 'Encrypted comms specialist',         icon: 'cellphone-key', priceHourly:  75},
];

export default function CustomizeAddOnsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);
  const confirmBooking = useBookingStore(st => st.confirmBooking);
  const [submitting, setSubmitting] = useState(false);

  const {cpo_count, vehicle_count, driver_only, addon_switches, passengers} = draft;

  // Passengers set the vehicle floor (1 per 3 pax). The user can add vehicles
  // but not drop below what the party physically needs.
  const minVehicles = vehiclesForPassengers(passengers);

  // Driver-only (client vehicle): passengers + CPOs all share the client's car,
  // so CPOs are capped to the free seats. With Bravo vehicles CPOs ride in
  // Bravo cars, so the full MAX_CPOS is available.
  const maxCpos = driver_only ? maxCposForClientVehicle(passengers) : MAX_CPOS;

  const setCount = (k: 'cpo_count' | 'vehicle_count', d: number) => {
    const cur = (draft[k] as number) ?? 1;
    const floor = k === 'vehicle_count' ? minVehicles : 1;
    const ceil = k === 'cpo_count' ? maxCpos : 4;
    const next = Math.max(floor, Math.min(ceil, cur + d));
    updateDraft({[k]: next} as never);
  };

  // Keep vehicle_count at the passenger-derived floor and CPOs within the
  // client-vehicle seat limit on entry / when inputs change upstream.
  useEffect(() => {
    if (!driver_only && (vehicle_count ?? 1) < minVehicles) {
      updateDraft({vehicle_count: minVehicles});
    }
    if (cpo_count > maxCpos) {
      updateDraft({cpo_count: maxCpos});
    }
  }, [minVehicles, vehicle_count, driver_only, cpo_count, maxCpos, updateDraft]);

  // Driver-only (client vehicle): the client supplies the car, so Bravo assigns
  // no vehicle. Restore the passenger-derived count when toggled off; clamp CPOs
  // to the client-car seat limit when toggled on.
  const toggleDriverOnly = () => {
    const next = !driver_only;
    updateDraft({
      driver_only: next,
      vehicle_count: next ? 0 : minVehicles,
      cpo_count: next ? Math.min(cpo_count, maxCposForClientVehicle(passengers)) : cpo_count,
    });
  };

  const toggleAddon = (k: string) =>
    updateDraft({addon_switches: {...addon_switches, [k]: !addon_switches?.[k]}});

  const rateBc = useMemo(() => {
    const addOnsBcPerHour = ADDONS.reduce(
      (sum, a) => (addon_switches?.[a.key] ? sum + a.priceHourly : sum),
      0,
    );
    return rateBcPerHour({
      cpoCount: cpo_count,
      vehicleCount: vehicle_count,
      driverOnly: driver_only,
      addOnsBcPerHour,
    });
  }, [cpo_count, vehicle_count, driver_only, addon_switches]);

  // LM-M1 — the AUTHORITATIVE quote. The escrow charge is the TOTAL (rate ×
  // hours + server surcharges), but this screen previously stored the PER-HOUR
  // rate as `estimated_price`, so the paywall under-asked ~4× and the "PAID"
  // line lied. Fetch the server estimate (debounced) and always carry a TOTAL.
  const durationHours = Math.max(1, draft.duration_hours ?? 4);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setServerTotal(null);
    const t = setTimeout(() => {
      const selected = Object.entries(addon_switches ?? {}).filter(([, v]) => v).map(([k]) => k);
      bookingApi.estimatePrice({
        type: 'transfer',
        region: draft.region,
        duration_hours: durationHours,
        add_ons: selected,
        cpo_count,
        vehicle_count,
        driver_only,
        pickup_time: draft.start_time || undefined,
      })
        .then(({data}) => { if (alive && typeof data?.total === 'number') {setServerTotal(data.total);} })
        .catch(() => undefined); // offline → the local rate×hours fallback below
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [cpo_count, vehicle_count, driver_only, addon_switches, durationHours, draft.region, draft.start_time]);
  const totalBc = serverTotal ?? rateBc * durationHours;

  const selectedCount = Object.values(addon_switches ?? {}).filter(Boolean).length;
  const needsOpsApproval = cpo_count > 1 || (!driver_only && vehicle_count > 1);
  // Step 22 — the auto path shares the client's live location with the assigned
  // agency, so the CTA is gated on an explicit, opt-in consent. Legacy ops-mediated
  // bookings keep their existing implicit flow (no gate).
  // Bug 1: server-driven auto-dispatch flag (replaces build-time AUTO_DISPATCH). Reactive selector.
  const consentRequired = useAuthStore(s => s.user?.auto_dispatch_enabled === true);
  const consentGiven = draft.location_consent === true;
  const ctaBlocked = submitting || (consentRequired && !consentGiven);

  const handleSubmit = async () => {
    if (submitting) {return;}
    const selectedList = Object.entries(addon_switches ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    // LM-M1 — estimated_price is the TOTAL the escrow will hold, never the hourly rate.
    updateDraft({selected_add_ons: selectedList, estimated_price: totalBc});

    setSubmitting(true);
    try {
      // Persist server-side BEFORE navigating, so re-entering the Secure tab
      // resumes into the right screen rather than a purely client-side one.
      const booking = await confirmBooking();
      // Step 19 — route by the returned status: an auto request comes back DISPATCHING
      // (→ Finding) or NO_PROVIDER (→ NoDetail); the legacy flow stays → OpsRoomReview.
      const st = (booking.status ?? '').toString().toUpperCase();
      if (st === 'DISPATCHING') {
        navigation.navigate('FindingDetail', {bookingId: booking.id});
      } else if (st === 'NO_PROVIDER') {
        navigation.navigate('NoDetail', {bookingId: booking.id});
      } else {
        navigation.navigate('OpsRoomReview', {bookingId: booking.id});
      }
    } catch (e) {
      // Step 19 — the auto affordability soft-check short-circuits to top up first.
      const direct = e as {code?: string; amountDue?: number};
      if (direct?.code === 'insufficient_credits') {
        navigation.navigate('CreditPaywall', {source: 'booking-flow', amountDue: direct.amountDue});
        return;
      }
      if (direct?.code === 'consent_required') {
        Alert.alert('Consent required', 'Please confirm location-sharing consent to find an agency.');
        return;
      }
      const msg = (e as {response?: {data?: {code?: string; booking_id?: string; message?: string}}; message?: string})?.response?.data;
      if (msg?.code === 'active_booking_exists' && msg.booking_id) {
        navigation.navigate('OpsRoomReview', {bookingId: msg.booking_id});
        return;
      }
      Alert.alert(
        'Booking failed',
        msg?.message ?? (e as Error).message ?? 'Could not submit booking. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      <View pointerEvents="none" style={s.ambient} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle} numberOfLines={1} ellipsizeMode="tail">Team &amp; Add-ons</Text>
          <Text style={s.headerSub}>STEP 5 · BUILD YOUR DETAIL</Text>
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 14}}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Team composition ── */}
        <View style={s.teamCard}>
          <View style={s.cardTopLight} />
          <Text style={s.sectionLabel}>TEAM COMPOSITION</Text>
          <View style={s.teamCols}>
            <TeamCell
              cap="CPOs"
              value={cpo_count}
              minusDisabled={cpo_count <= 1}
              plusDisabled={cpo_count >= maxCpos}
              onMinus={() => setCount('cpo_count', -1)}
              onPlus={() => setCount('cpo_count', +1)}
            />
            {driver_only ? (
              <View style={s.teamCell}>
                <Text style={s.teamCellCap}>VEHICLES</Text>
                <View style={s.clientVehicle}>
                  <Icon name="car-key" size={18} color={D.accentSoft} />
                  <Text style={s.clientVehicleText}>Client</Text>
                </View>
              </View>
            ) : (
              <TeamCell
                cap="VEHICLES + DRIVERS"
                value={vehicle_count}
                minusDisabled={vehicle_count <= minVehicles}
                onMinus={() => setCount('vehicle_count', -1)}
                onPlus={() => setCount('vehicle_count', +1)}
              />
            )}
          </View>
          <Text style={s.teamNote}>
            {driver_only
              ? `Client vehicle seats ${passengers} passengers + ${maxCpos} CPO${maxCpos === 1 ? '' : 's'} (driver takes 1 seat).`
              : passengers > 3
              ? `${passengers} passengers require at least ${minVehicles} vehicles · 3 per vehicle.`
              : 'Each vehicle carries up to 3 passengers · 3 per vehicle.'}
          </Text>
        </View>

        {/* ── Driver Only toggle ── */}
        <TouchableOpacity
          style={[s.driverRow, driver_only && s.driverRowOn]}
          onPress={toggleDriverOnly}
          activeOpacity={0.85}>
          {driver_only && <View style={s.cardTopLightSm} />}
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.driverTitle}>Driver Only (Client Vehicle)</Text>
            <Text style={s.driverDesc}>Client provides vehicle — Bravo driver only</Text>
          </View>
          <Toggle on={driver_only} onPress={toggleDriverOnly} label="Driver only" />
        </TouchableOpacity>

        {/* ── Approval notice ── */}
        {needsOpsApproval && (
          <View style={s.alertWarn}>
            <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
            <Text style={s.alertText}>
              Selecting more than baseline (1 CPO + 1 Vehicle) requires{' '}
              <Text style={s.alertBold}>Control Room approval</Text> and a minimum 3-hour additional lead time.
            </Text>
          </View>
        )}

        {/* ── Optional add-ons ── */}
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>OPTIONAL ADD-ONS</Text>
          <Text style={s.sectionMeta}>{selectedCount} SELECTED</Text>
        </View>

        <View style={{gap: 10}}>
          {ADDONS.map(a => (
            <AddonRow
              key={a.key}
              icon={a.icon}
              title={a.title}
              desc={a.desc}
              price={a.priceHourly}
              on={!!addon_switches?.[a.key]}
              onToggle={() => toggleAddon(a.key)}
            />
          ))}
        </View>

        {/* ── Location-sharing consent (auto path only) ── */}
        {consentRequired && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => updateDraft({location_consent: !consentGiven})}
            style={[s.consentRow, consentGiven && s.consentRowOn]}
            accessibilityRole="checkbox"
            accessibilityState={{checked: consentGiven}}>
            <View style={[s.checkbox, consentGiven && s.checkboxOn]}>
              {consentGiven && <Icon name="check" size={14} color="#fff" />}
            </View>
            <Text style={s.consentText}>
              I consent to sharing my live location with the assigned agency for the duration of
              this detail, and I accept the{' '}
              <Text style={s.consentLink}>Dispatch Terms</Text>.
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Rate bar ── */}
        <View style={s.rateBar}>
          <View style={s.rateBarTopLight} />
          <View>
            <Text style={s.rateCap}>CURRENT RATE</Text>
            <Text style={s.rateSub}>Bravo Credits / hour</Text>
          </View>
          <View style={s.rateAmtRow}>
            <Text style={s.rateAmt}>{rateBc.toLocaleString()}</Text>
            <Text style={s.rateUnit}>BC</Text>
          </View>
        </View>
        {/* LM-M1 — the number escrow will actually hold, shown BEFORE submit. */}
        <View style={s.totalRow}>
          <Text style={s.totalCap} numberOfLines={1} ellipsizeMode="tail">ESTIMATED TOTAL · {durationHours}H</Text>
          <Text style={s.totalAmt}>{Math.round(totalBc).toLocaleString()} BC</Text>
        </View>
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}>
        <TouchableOpacity
          activeOpacity={ctaBlocked ? 1 : 0.9}
          onPress={() => { void handleSubmit(); }}
          disabled={ctaBlocked}>
          <LinearGradient
            colors={ctaBlocked ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, ctaBlocked && s.ctaDisabled]}>
            <Text style={s.ctaText}>
              {submitting ? 'Submitting…' : consentRequired ? 'Find an agency' : 'Submit for Ops Review'}
            </Text>
            {!submitting && <Icon name="arrow-right" size={19} color="#fff" />}
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

function Toggle({on, onPress, label}: {on: boolean; onPress: () => void; label: string}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={[s.toggle, on && s.toggleOn]}
      accessibilityRole="switch"
      accessibilityState={{checked: on}}
      accessibilityLabel={label}
      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
      {on ? (
        <LinearGradient
          colors={['#6E9BF5', D.accentDeep]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={StyleSheet.absoluteFill as never}
        />
      ) : null}
      <View style={[s.toggleThumb, on && s.toggleThumbOn]} />
    </TouchableOpacity>
  );
}

interface TeamCellProps {
  cap: string;
  value: number;
  minusDisabled?: boolean;
  plusDisabled?: boolean;
  onMinus: () => void;
  onPlus: () => void;
}

function TeamCell({cap, value, minusDisabled, plusDisabled, onMinus, onPlus}: TeamCellProps) {
  return (
    <View style={s.teamCell}>
      <Text style={s.teamCellCap}>{cap}</Text>
      <View style={s.teamCellRow}>
        <TouchableOpacity
          style={[s.stepBtn, minusDisabled && s.stepBtnDisabled]}
          onPress={onMinus}
          disabled={minusDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="minus" size={15} color={minusDisabled ? D.textFaint : D.textDim} />
        </TouchableOpacity>
        <Text style={s.stepVal}>{value}</Text>
        <TouchableOpacity
          onPress={onPlus}
          disabled={plusDisabled}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <LinearGradient
            colors={plusDisabled ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accentDeep]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.stepBtnPri, plusDisabled && s.stepBtnDisabled]}>
            <Icon name="plus" size={15} color={plusDisabled ? D.textFaint : '#fff'} />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface AddonRowProps {
  icon: IconName;
  title: string;
  desc: string;
  price: number;
  on: boolean;
  onToggle: () => void;
}

function AddonRow({icon, title, desc, price, on, onToggle}: AddonRowProps) {
  return (
    <TouchableOpacity style={[s.addon, on ? s.addonOn : s.addonIdle]} onPress={onToggle} activeOpacity={0.85}>
      {on && <View style={s.cardTopLightSm} />}
      <View style={[s.addonIc, on ? s.addonIcOn : s.addonIcIdle]}>
        <Icon name={icon} size={21} color={on ? D.accentSoft : D.textMute} />
      </View>
      <View style={s.addonBody}>
        <View style={s.addonTitleRow}>
          <Text style={s.addonTitle} numberOfLines={1}>{title}</Text>
          <Text style={[s.addonPrice, on && s.addonPriceOn]}>+{price} BC/hr</Text>
        </View>
        <Text style={s.addonDesc} numberOfLines={1}>{desc}</Text>
      </View>
      <Toggle on={on} onPress={onToggle} label={title} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 260, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  scroll: {flex: 1},

  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.1)'},
  cardTopLightSm: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(120,160,255,0.34)'},

  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},

  // Team composition
  teamCard: {
    position: 'relative', overflow: 'hidden',
    borderRadius: 20, padding: 16,
    backgroundColor: 'rgba(18,24,36,0.7)', borderWidth: 1, borderColor: D.hair2,
  },
  teamCols: {flexDirection: 'row', gap: 12, marginTop: 14},
  teamCell: {
    flex: 1, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center',
  },
  teamCellCap: {
    fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1.4,
    color: D.textMute, marginBottom: 11,
  },
  teamCellRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  stepBtn: {
    width: 36, height: 36, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnDisabled: {opacity: 0.4},
  stepBtnPri: {
    width: 36, height: 36, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  stepVal: {minWidth: 38, textAlign: 'center', fontFamily: D.fBold, fontSize: 22, color: D.text},
  clientVehicle: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  clientVehicleText: {fontFamily: D.fSemi, fontSize: 14, color: D.accentSoft},
  teamNote: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 13, textAlign: 'center'},

  // Driver-only row
  driverRow: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  driverRowOn: {backgroundColor: 'rgba(20,32,56,0.9)', borderColor: 'rgba(91,141,239,0.45)'},
  driverTitle: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: -0.2, color: D.text},
  driverDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Toggle
  toggle: {
    width: 48, height: 28, borderRadius: 999, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: D.hair2,
    justifyContent: 'center',
  },
  toggleOn: {borderColor: 'rgba(255,255,255,0.2)'},
  toggleThumb: {
    position: 'absolute', left: 2.5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: {width: 0, height: 2}, elevation: 3,
  },
  toggleThumbOn: {left: 22},

  // Approval notice
  alertWarn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 17},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  // Section row
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.textMute},

  // Add-on rows
  addon: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 15, borderRadius: 17,
  },
  addonIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  addonOn: {
    backgroundColor: 'rgba(20,32,56,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    shadowColor: D.accentDeep, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: {width: 0, height: 10}, elevation: 7,
  },
  addonIc: {
    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  addonIcIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  addonIcOn: {
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    shadowColor: D.accent, shadowOpacity: 0.24, shadowRadius: 16, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  addonBody: {flex: 1, minWidth: 0},
  addonTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  addonTitle: {flex: 1, fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2, color: D.text},
  addonPrice: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 0.4, color: D.textMute},
  addonPriceOn: {color: D.accentSoft},
  addonDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Rate bar
  rateBar: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 16, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  rateBarTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  rateCap: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, color: D.textDim},
  rateSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 4},
  rateAmtRow: {flexDirection: 'row', alignItems: 'baseline', gap: 5},
  rateAmt: {fontFamily: D.fBold, fontSize: 24, letterSpacing: -0.5, color: D.text},
  rateUnit: {fontFamily: D.fBold, fontSize: 14, color: D.accentSoft},
  // LM-M1 — estimated-total strip under the rate bar.
  totalRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginTop: -6,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  totalCap: {flexShrink: 1, fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.4, color: D.textMute},
  totalAmt: {flexShrink: 0, fontFamily: D.fBold, fontSize: 16, color: D.accentSoft},

  // Consent (auto path)
  consentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  consentRowOn: {borderColor: 'rgba(91,141,239,0.45)', backgroundColor: 'rgba(91,141,239,0.08)'},
  checkbox: {
    width: 22, height: 22, borderRadius: 7, marginTop: 1,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: D.textMute, backgroundColor: 'transparent',
  },
  checkboxOn: {backgroundColor: D.accent, borderColor: D.accent},
  consentText: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  consentLink: {fontFamily: D.fSemi, color: D.accentSoft},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    height: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
