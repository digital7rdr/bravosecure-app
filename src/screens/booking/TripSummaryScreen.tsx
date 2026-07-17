/**
 * Trip Summary
 *
 * Read-only view of a completed or cancelled booking. Shows the booking
 * suffix (matching the ops console — last 12 chars), route, status,
 * total paid, assigned team (if any), and timestamps. Reached by tapping
 * a terminal-state row in Recent Bookings on BookingHomeScreen.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp, NativeStackScreenProps} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UI} from '@components/ui/tokens';
import {bookingApi, assignmentApi, type AssignedCpoDto, type AssignedVehicleDto} from '@services/api';
import {describeStatus} from './bookingStatus';
import type {Booking} from '../../types';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
type Props = NativeStackScreenProps<BookingStackParamList, 'TripSummary'>;

function bookingSuffix(id: string): string {
  return id.replace(/-/g, '').slice(-12).toUpperCase();
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  // UTC so the trip time matches the backend/ops value on every device.
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + 'Z';
}

function locationLabel(loc: {address?: string; latitude?: number; longitude?: number} | undefined): string {
  if (!loc) {return '—';}
  if (loc.address) {return loc.address;}
  if (loc.latitude !== undefined && loc.longitude !== undefined) {
    return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
  }
  return '—';
}

export default function TripSummaryScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const route      = useRoute<Props['route']>();
  const {bookingId} = route.params;

  const [booking, setBooking] = useState<Booking | null>(null);
  const [team,    setTeam]    = useState<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null} | null>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      try {
        const [bRes, tRes] = await Promise.all([
          bookingApi.getById(bookingId),
          assignmentApi.getTeam(bookingId).catch(() => ({data: null} as const)),
        ]);
        if (cancelled) {return;}
        setBooking(bRes.data);
        setTeam(tRes.data ?? null);
      } catch (e) {
        if (!cancelled) {setErr((e as Error).message);}
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId, reloadKey]);

  const display = describeStatus(booking?.status);
  const isCompleted = (booking?.status ?? '').toUpperCase() === 'COMPLETED';
  const isCancelled = (booking?.status ?? '').toUpperCase() === 'CANCELLED';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      <View style={s.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={s.back}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Trip Summary</Text>
        <View style={{width: 32}} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={UI.accent} />
        </View>
      ) : err ? (
        <View style={s.center}>
          <Icon name="alert-circle-outline" size={28} color="#F87171" />
          <Text style={s.errText}>{err}</Text>
          <TouchableOpacity
            style={s.retryBtn}
            activeOpacity={0.85}
            onPress={() => setReloadKey(k => k + 1)}
            accessibilityRole="button"
            accessibilityLabel="Retry loading trip summary">
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !booking ? (
        <View style={s.center}>
          <Text style={s.errText}>Booking not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

          {/* Hero — booking suffix + status */}
          <View style={s.hero}>
            <View style={s.heroBadge}>
              <Icon
                name={isCompleted ? 'check-decagram' : isCancelled ? 'close-octagon' : 'shield'}
                size={26}
                color={display.color}
              />
            </View>
            <Text style={s.heroRef}>BL-{bookingSuffix(booking.id)}</Text>
            <View style={[s.statusChip, {borderColor: display.color + '60', backgroundColor: display.color + '14'}]}>
              <Text style={[s.statusChipText, {color: display.color}]}>{display.label}</Text>
            </View>
            <Text style={s.heroSub}>
              {booking.type?.toString().replace(/_/g, ' ')} · {(booking as Booking & {region?: string}).region ?? '—'}
            </Text>
          </View>

          {/* Route */}
          <Section title="ROUTE">
            <Row k="Pickup"  v={locationLabel(booking.pickup)} />
            <Row k="Dropoff" v={locationLabel(booking.dropoff ?? undefined)} />
            <Row k="Started" v={formatDateTime(booking.start_time)} />
            <Row k="Ended"   v={formatDateTime(booking.end_time ?? booking.created_at)} />
            <Row k="Duration"
                 v={booking.duration_hours !== undefined ? `${booking.duration_hours} hour${booking.duration_hours === 1 ? '' : 's'}` : '—'} />
          </Section>

          {/* Order */}
          <Section title="ORDER">
            <Row k="CPOs"      v={`${booking.cpo_count ?? 0}`} />
            <Row k="Vehicle"   v={(booking.vehicle_type ?? '—').toString()} />
            <Row k="Add-ons"
                 v={booking.add_ons && booking.add_ons.length > 0
                    ? booking.add_ons.join(' · ')
                    : 'None'} />
            <Row k="Payment"   v={(booking.payment_method ?? '—').toString().replace(/_/g, ' ')} />
            <Row k="Total"     v={`${(booking.total_eur ?? booking.total_price ?? 0).toLocaleString()} BC`} highlight />
          </Section>

          {/* Team */}
          {team && (team.cpos.length > 0 || team.vehicle) && (
            <Section title="ASSIGNED TEAM">
              {team.cpos.map(c => (
                <View key={c.call_sign} style={s.crewRow}>
                  <View style={s.crewAv}>
                    <Text style={s.crewAvText}>{c.call_sign?.slice(-2) ?? '?'}</Text>
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.crewName} numberOfLines={1}>{c.call_sign} · {c.display_name}</Text>
                    <Text style={s.crewSub}>{c.role ?? 'CP'}</Text>
                  </View>
                </View>
              ))}
              {team.vehicle && (
                <View style={s.crewRow}>
                  <View style={[s.crewAv, {backgroundColor: 'rgba(91,141,239,0.18)'}]}>
                    <Icon name="car" size={14} color={UI.accent} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.crewName} numberOfLines={1}>{team.vehicle.call_sign} · {team.vehicle.make_model}</Text>
                    <Text style={s.crewSub}>
                      {team.vehicle.armored ? `Armored · ${team.vehicle.armor_grade ?? 'B-grade'}` : 'Soft-skin'}
                      {' · '}{team.vehicle.plate}
                    </Text>
                  </View>
                </View>
              )}
            </Section>
          )}

          {/* Notes */}
          {booking.notes && (
            <Section title="NOTES">
              <Text style={s.notes}>{booking.notes}</Text>
            </Section>
          )}

          {/* Outcome banner */}
          {isCompleted && (
            <View style={[s.outcome, {borderColor: '#4ADE8060', backgroundColor: 'rgba(74,222,128,0.06)'}]}>
              <Icon name="check-decagram" size={18} color="#4ADE80" />
              <Text style={[s.outcomeText, {color: '#4ADE80'}]}>
                Mission delivered. Payouts settled. Group chat dissolved.
              </Text>
            </View>
          )}

          {/* Step 24 — rate the agency (idempotent server-side; safe to re-open) */}
          {isCompleted && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigation.navigate('RateAgency', {bookingId: booking.id})}
              style={s.rateBtn}>
              <Icon name="star-outline" size={18} color="#0B0E14" />
              <Text style={s.rateBtnText}>Rate the agency</Text>
            </TouchableOpacity>
          )}
          {/* F1 — the numbered receipt (or credit note for a refunded terminal). */}
          {(isCompleted || isCancelled) && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Invoice', {bookingId: booking.id})}
              style={[s.rateBtn, {backgroundColor: 'rgba(91,141,239,0.12)'}]}>
              <Icon name="file-document-outline" size={18} color="#A9C5FF" />
              <Text style={[s.rateBtnText, {color: '#A9C5FF'}]}>
                {isCompleted ? 'View invoice' : 'View credit note'}
              </Text>
            </TouchableOpacity>
          )}
          {isCancelled && (
            <View style={[s.outcome, {borderColor: '#F8717160', backgroundColor: 'rgba(248,113,113,0.06)'}]}>
              <Icon name="close-octagon" size={18} color="#F87171" />
              <Text style={[s.outcomeText, {color: '#F87171'}]}>
                Booking cancelled. Any escrowed credits were refunded.
              </Text>
            </View>
          )}

          <View style={{height: 24}} />
        </ScrollView>
      )}
    </View>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function Row({k, v, highlight}: {k: string; v: string; highlight?: boolean}) {
  return (
    <View style={s.row}>
      <Text style={s.rowK}>{k}</Text>
      <Text style={[s.rowV, highlight && s.rowVHighlight]} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  back: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)',
  },
  headerTitle: {
    fontSize: 14, fontWeight: '700', letterSpacing: 1.2,
    color: UI.text,
  },

  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32},
  errText: {color: '#F87171', fontSize: 12, textAlign: 'center'},
  retryBtn: {
    paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, marginTop: 4,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  retryText: {fontSize: 12.5, fontWeight: '700', color: UI.accentSoft},

  scroll: {padding: 14, paddingBottom: 32, gap: 12},

  hero: {
    alignItems: 'center', padding: 20, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.18)',
  },
  heroBadge: {
    width: 56, height: 56, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)',
    marginBottom: 12,
  },
  heroRef: {
    fontFamily: 'JetBrains Mono', fontSize: 17, fontWeight: '800',
    color: UI.text, letterSpacing: 1.2,
  },
  heroSub: {
    fontSize: 11, color: UI.textDim, marginTop: 6,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },

  statusChip: {
    marginTop: 10, paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
  },
  statusChipText: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1.4,
  },

  section: {gap: 6},
  sectionTitle: {
    fontSize: 10, fontWeight: '800', letterSpacing: 1.5,
    color: UI.textDim,
  },
  card: {
    borderRadius: 12, backgroundColor: UI.surface,
    borderWidth: 1, borderColor: UI.hair,
    padding: 4,
  },

  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 9, paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.hair,
    gap: 12,
  },
  rowK: {
    fontSize: 10, color: UI.textDim,
    letterSpacing: 1.1, textTransform: 'uppercase', fontWeight: '700',
    flexShrink: 0,
  },
  rowV: {
    fontSize: 12, color: UI.text, fontWeight: '600',
    flex: 1, textAlign: 'right',
  },
  rowVHighlight: {color: UI.accent, fontSize: 14, fontWeight: '800'},

  crewRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.hair,
  },
  crewAv: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.18)',
  },
  crewAvText: {
    color: UI.text, fontWeight: '800', fontSize: 11, letterSpacing: 0.5,
  },
  crewName: {fontSize: 12, fontWeight: '700', color: UI.text},
  crewSub:  {fontSize: 10, color: UI.textDim, marginTop: 2},

  notes: {fontSize: 12, color: UI.text, padding: 10, lineHeight: 17},

  outcome: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 12, borderRadius: 10, borderWidth: 1,
  },
  outcomeText: {flex: 1, fontSize: 11.5, fontWeight: '700', lineHeight: 16},
  rateBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 14, backgroundColor: '#F5C76B', marginTop: 4,
  },
  rateBtnText: {fontSize: 14.5, fontWeight: '700', color: '#0B0E14'},
}));
