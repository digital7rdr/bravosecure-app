/**
 * CPO · Assigned Mission (BUILD_RUNBOOK Step 21) — the guard's Mission tab. Shows the brief
 * (principal, route, dress), the crew roster with the lead ★starred + "YOU", the shared
 * MissionStepper, and — for the LEAD only — the ONE context-aware control:
 *   DISPATCHED → Start · PICKUP → Go live · LIVE → Finish (deliberate confirm).
 * Non-leads see the same job read-only ("the lead is advancing") with chat + SOS. A floating
 * SOS is always one tap once the detail is PICKUP/LIVE. On a failed transition the state never
 * lies (stays put); a re-tap after a lost-200 is safe (idempotency-keyed). Obsidian + cobalt.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, RefreshControl,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import Geolocation from 'react-native-geolocation-service';
import {agentApi, isAuthLostError} from '@services/api';
import {useAuthStore} from '@store/authStore';
import MissionStepper from '@components/mission/MissionStepper';
import {missionActionView, type MissionAction} from './missionAction';
import {useLeadTelemetry} from './useLeadTelemetry';
import {scaleTextStyles} from '@utils/scaling';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.09)', accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

type Deployment = Awaited<ReturnType<typeof agentApi.getMissionDeployment>>['data'];
const POLL_MS = 8000;

const CHECK_LABELS: Record<string, string> = {
  dress: 'Dress code', vehicle: 'Vehicle ready', equip: 'Equipment', briefing: 'Briefing done',
};

// LM-C3 — best-effort device fix for the geofence warning on transitions.
// Never blocks the action: a denied permission / timeout resolves undefined.
function bestEffortFix(): Promise<{lat: number; lng: number} | undefined> {
  return new Promise(resolve => {
    const done = setTimeout(() => resolve(undefined), 3_000);
    try {
      Geolocation.getCurrentPosition(
        pos => { clearTimeout(done); resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}); },
        () => { clearTimeout(done); resolve(undefined); },
        {enableHighAccuracy: false, timeout: 2_500, maximumAge: 30_000},
      );
    } catch { clearTimeout(done); resolve(undefined); }
  });
}

export default function AssignedMissionDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{navigate: (n: string, p?: Record<string, unknown>) => void}>();
  const [missionId, setMissionId] = useState<string | null>(null);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isLead, setIsLead] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState(false);
  const [sosBusy, setSosBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const mounted = useRef(true);
  // Monotonic request token: only the LATEST-issued load() may write state. Prevents an
  // older in-flight poll (that read a pre-transition status) from clobbering the truth a
  // newer read just wrote — e.g. resurrecting the Finish button after a successful complete.
  const reqGen = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    const gen = ++reqGen.current;
    const fresh = () => mounted.current && gen === reqGen.current;
    try {
      const {data: am} = await agentApi.getActiveMission();
      if (!fresh()) { return; }
      if (!am) { setMissionId(null); setDep(null); setStatus(''); return; }
      setMissionId(am.mission_id);
      setStatus(am.status);
      setIsLead(am.is_lead);
      try {
        const {data} = await agentApi.getMissionDeployment(am.mission_id);
        if (!fresh()) { return; }
        setDep(data);
        if (data.mission?.status) { setStatus(data.mission.status); }
        if (data.crew_role) { setIsLead(data.crew_role.is_lead); }
      } catch { /* keep the active-mission summary */ }
    } finally { if (fresh()) { setLoading(false); setRefreshing(false); } }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // LM-C5 — stream the lead's GPS while the Mission tab is open (previously the
  // dot only moved while the buried lead-console overlay was mounted).
  useLeadTelemetry(missionId, isLead, status);

  const av = missionActionView(status, isLead);

  const runAction = useCallback(async (action: MissionAction) => {
    if (!missionId || acting) {return;}
    const call = action === 'start' ? agentApi.missionPickup
      : action === 'go-live' ? agentApi.missionGoLive
      : action === 'finish' ? agentApi.missionComplete : null;
    if (!call) {return;}
    setActing(true);
    try {
      // LM-C3 — carry the device fix so the server can geofence-warn ops.
      const fix = await bestEffortFix();
      await call(missionId, fix);
      await load(); // re-read truth; never optimistically claim "completed"
    } catch (e: unknown) {
      // B-76 — a genuine session loss (single-device takeover: the same account
      // signed in on another phone) surfaces here as a 401 the refresh couldn't
      // recover. Don't dump the raw `token_revoked` string as "could not advance";
      // tell the CPO plainly and hand off to the standard sign-out teardown so the
      // RootNavigator returns them to the login screen. signOut() is idempotent.
      if (isAuthLostError(e)) {
        Alert.alert('Signed out',
          'Your session ended — your account may have signed in on another device. Please sign in again.');
        void useAuthStore.getState().signOut();
        return;
      }
      // Re-read truth so a lost-200 (server advanced, we saw a network error) reconciles
      // immediately instead of waiting for the next poll — the re-read's higher request
      // token also wins over any stale in-flight poll.
      await load();
      const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
      const code = Array.isArray(raw) ? raw[0] : raw;
      Alert.alert('Could not advance',
        code === 'deploy_checks_incomplete'
          ? 'Complete your deploy checks (dress, vehicle, equipment, briefing) before starting.'
          : (typeof code === 'string' ? code : (e as Error).message) ?? 'Try again — your mission is unchanged.');
    } finally { setActing(false); }
  }, [missionId, acting, load]);

  // LM-C2 — self-acknowledge a deploy check; all four gate the lead's Start.
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const ackCheck = useCallback(async (key: string) => {
    if (!missionId || ackBusy) {return;}
    setAckBusy(key);
    try {
      await agentApi.acknowledgeDeployCheck(missionId, key);
      await load();
    } catch (e: unknown) {
      Alert.alert('Could not acknowledge', (e as Error).message ?? 'Try again.');
    } finally { setAckBusy(null); }
  }, [missionId, ackBusy, load]);

  // LM-C4 — non-lead "I'm in position" check-in.
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const checkIn = useCallback(async () => {
    if (!missionId || checkinBusy) {return;}
    setCheckinBusy(true);
    try {
      await agentApi.crewCheckIn(missionId);
      setCheckedIn(true);
    } catch (e: unknown) {
      Alert.alert('Check-in failed', (e as Error).message ?? 'Try again.');
    } finally { setCheckinBusy(false); }
  }, [missionId, checkinBusy]);

  // F3 — the lead's half of the on-arrival identity handshake: the rotating
  // code the CLIENT compares against. Fetched while DISPATCHED/PICKUP.
  const [verifyCode, setVerifyCode] = useState<string | null>(null);
  useEffect(() => {
    const stNow = status.toUpperCase();
    if (!missionId || !isLead || (stNow !== 'DISPATCHED' && stNow !== 'PICKUP')) {
      setVerifyCode(null);
      return undefined;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const {data} = await agentApi.missionVerifyCode(missionId);
        if (!alive) {return;}
        setVerifyCode(data.code);
        const ms = Math.max(5_000, new Date(data.rotates_at).getTime() - Date.now());
        timer = setTimeout(() => { void pull(); }, Math.min(ms, 60_000));
      } catch {
        if (alive) {timer = setTimeout(() => { void pull(); }, 20_000);}
      }
    };
    void pull();
    return () => { alive = false; if (timer) {clearTimeout(timer);} };
  }, [missionId, isLead, status]);

  // LM-C7 — crew asks the agency to close the mission (lead unreachable).
  const [reqBusy, setReqBusy] = useState(false);
  const requestCompletion = useCallback(() => {
    if (!missionId) {return;}
    Alert.alert('Request completion?',
      'Use this when the mission is finished but your lead can’t close it (phone dead / unreachable). Your agency will confirm.',
      [{text: 'Cancel', style: 'cancel'},
       {text: 'Request', onPress: () => {
         setReqBusy(true);
         agentApi.requestComplete(missionId)
           .then(() => Alert.alert('Requested', 'Your agency has been notified.'))
           .catch((e: unknown) => Alert.alert('Could not request', (e as Error).message ?? 'Try again.'))
           .finally(() => setReqBusy(false));
       }}]);
  }, [missionId]);

  // CPO-WAYPOINTS (#12) — lead-only manual waypoint mark from the Mission tab, so
  // the timeline fills as the lead advances without the buried lead console.
  const markWp = useCallback(async (tag: 'DISPATCH' | 'RECON' | 'PICKUP' | 'DROPOFF') => {
    if (!missionId || marking) {return;}
    setMarking(true);
    try {
      await agentApi.markWaypoint(missionId, tag);
      await load();
    } catch (e: unknown) {
      Alert.alert('Mark failed', (e as Error).message ?? 'Try again.');
    } finally { setMarking(false); }
  }, [missionId, marking, load]);

  const onAdvance = useCallback(() => {
    if (av.action === 'none') {return;}
    if (av.confirm) {
      Alert.alert('Finish the mission?', 'This ends the detail and releases payment to your agency. Only finish once the principal is safely handed over.',
        [{text: 'Cancel', style: 'cancel'}, {text: 'Finish mission', style: 'destructive', onPress: () => { void runAction('finish'); }}]);
    } else {
      void runAction(av.action);
    }
  }, [av, runAction]);

  const raiseSos = useCallback(async () => {
    if (!missionId || sosBusy) {return;}
    setSosBusy(true);
    try {
      await agentApi.raiseSos(missionId, {reason: 'cpo_field_sos'});
      Alert.alert('SOS raised', 'Your crew and ops have been alerted.');
    } catch (e: unknown) {
      Alert.alert('SOS failed', (e as Error).message ?? 'Try again.');
    } finally { setSosBusy(false); }
  }, [missionId, sosBusy]);

  const st = status.toUpperCase();
  const showSos = !!missionId && (st === 'PICKUP' || st === 'LIVE' || st === 'SOS');

  if (loading) {
    return <View style={[s.root, {paddingTop: insets.top}]}><StatusBar barStyle="light-content" backgroundColor={D.bg} /><View style={s.center}><ActivityIndicator color={D.accent} /></View></View>;
  }
  if (!missionId) {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={D.bg} />
        <View style={s.center}>
          <View style={s.emptyIcon}><Icon name="shield-outline" size={34} color={D.textMute} /></View>
          <Text style={s.emptyTitle}>No active mission</Text>
          <Text style={s.emptySub}>When your agency assigns you to a detail it appears here.</Text>
        </View>
      </View>
    );
  }

  const crew = dep?.crew ?? [];
  const wp = dep?.waypoints ?? [];

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>{dep?.mission?.short_code ?? 'MISSION'}</Text>
        <Text style={[s.statusBadge, st === 'SOS' && {color: D.alert}]}>{st}</Text>
      </View>

      <ScrollView contentContainerStyle={[s.body, {paddingBottom: insets.bottom + (showSos ? 150 : 90)}]} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>
        <View style={{marginBottom: 4}}><MissionStepper booking={{status: dep?.booking?.booking_status ?? 'CONFIRMED'}} mission={{status}} /></View>

        {/* Principal + route */}
        <View style={s.card}>
          {dep?.booking?.client_name && (
            <View style={s.cardRow}><Icon name="account-tie" size={15} color={D.accentSoft} /><Text style={s.cardVal}>{dep.booking.client_name}</Text></View>
          )}
          <View style={s.cardRow}><Icon name="map-marker" size={15} color={D.signal} /><Text style={s.cardVal} numberOfLines={2}>{dep?.booking?.pickup_address ?? '—'}</Text></View>
          {dep?.booking?.dropoff_address && (
            <View style={s.cardRow}><Icon name="map-marker-check" size={15} color={D.amber} /><Text style={s.cardVal} numberOfLines={2}>{dep.booking.dropoff_address}</Text></View>
          )}
          {dep?.dress_instructions && (
            <View style={s.cardRow}><Icon name="tshirt-crew" size={15} color={D.textMute} /><Text style={s.cardSub}>{dep.dress_instructions}</Text></View>
          )}
        </View>

        {/* F3 — the lead shows this code to the client on arrival; it must match
            the client's screen. Rotates server-side. */}
        {isLead && verifyCode && (st === 'DISPATCHED' || st === 'PICKUP') && (
          <View style={s.verifyCard}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              <Icon name="shield-account" size={15} color={D.accentSoft} />
              <Text style={s.verifyTitle}>Arrival code — show the principal</Text>
            </View>
            <Text style={s.verifyCode}>{verifyCode}</Text>
          </View>
        )}

        {/* LM-C2 — the four deploy checks (seeded at crew-assign, previously
            invisible on the CPO shell). All four gate the lead's Start. */}
        {st === 'DISPATCHED' && (dep?.checks?.length ?? 0) > 0 && (
          <>
            <Text style={s.sectionLabel}>DEPLOY CHECKS · {(dep?.checks ?? []).filter(c => c.state !== 'pending').length}/{dep?.checks?.length ?? 0}</Text>
            {(dep?.checks ?? []).map(c => {
              const done = c.state !== 'pending';
              return (
                <TouchableOpacity key={c.check_key} style={s.wpRow} activeOpacity={done ? 1 : 0.8}
                  disabled={done || ackBusy !== null}
                  onPress={() => { void ackCheck(c.check_key); }}>
                  <Icon name={done ? 'check-circle' : 'circle-outline'} size={15}
                    color={done ? D.signal : (ackBusy === c.check_key ? D.accentSoft : D.textMute)} />
                  <Text style={s.wpText}>{CHECK_LABELS[c.check_key] ?? c.check_key}</Text>
                  <Text style={s.wpEvent}>{done ? 'Confirmed' : ackBusy === c.check_key ? 'Confirming…' : 'Tap to confirm'}</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* Crew roster */}
        {crew.length > 0 && (
          <>
            <Text style={s.sectionLabel}>CREW</Text>
            {crew.map((c, i) => (
              <View key={`${c.team_idx}-${i}`} style={[s.crewRow, c.is_me && s.crewRowMe]}>
                <Icon name={c.is_lead ? 'star' : 'shield-account'} size={16} color={c.is_lead ? D.amber : D.accentSoft} />
                <Text style={s.crewName}>{c.call_sign ?? `Officer ${c.team_idx + 1}`}</Text>
                {c.is_me && <Text style={s.youTag}>YOU</Text>}
                <Text style={s.crewRole}>{c.is_lead ? 'LEAD' : c.role}</Text>
              </View>
            ))}
          </>
        )}

        {/* Waypoints — CPO-WAYPOINTS (#12): they fill as the lead advances (FSM
            auto-settles on Start/Finish; the lead can also mark the next one here). */}
        {wp.length > 0 && (() => {
          const MANUAL = ['DISPATCH', 'RECON', 'PICKUP', 'DROPOFF'] as const;
          const done = wp.filter(w => w.state === 'done').length;
          const active = status === 'DISPATCHED' || status === 'PICKUP' || status === 'LIVE';
          const nextManual = MANUAL.find(tag => {
            const w = wp.find(x => x.tag === tag);
            return w && w.state !== 'done';
          });
          return (
          <>
            <Text style={s.sectionLabel}>WAYPOINTS · {done}/{wp.length}</Text>
            {wp.map(w => (
              <View key={w.seq} style={s.wpRow}>
                <Icon name={w.state === 'done' ? 'check-circle' : 'circle-outline'} size={15} color={w.state === 'done' ? D.signal : D.textMute} />
                <Text style={s.wpText}>{w.tag}</Text>
                <Text style={s.wpEvent}>{w.event}</Text>
              </View>
            ))}
            {isLead && active && nextManual ? (
              <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} disabled={marking}
                onPress={() => { void markWp(nextManual); }}>
                <Icon name="map-marker-check" size={16} color={D.accentSoft} />
                <Text style={s.commsText}>{marking ? 'Marking…' : `Mark ${nextManual}`}</Text>
              </TouchableOpacity>
            ) : null}
          </>
          );
        })()}

        {(st === 'DISPATCHED' || st === 'PICKUP' || st === 'LIVE') && (
          <TouchableOpacity style={s.navBtn} activeOpacity={0.85}
            onPress={() => navigation.navigate('CpoLiveTracker', {missionId, mode: 'cpo'})}>
            <Icon name="navigation-variant" size={17} color="#fff" />
            <Text style={s.navBtnText}>Open live map · Navigate</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} onPress={() => navigation.navigate('CpoComms')}>
          <Icon name="message-text" size={17} color={D.accentSoft} />
          <Text style={s.commsText}>Open Ops Room</Text>
        </TouchableOpacity>

        {/* LM-C4 — non-lead "I'm in position" (the lead's Start speaks for them). */}
        {!isLead && (st === 'DISPATCHED' || st === 'PICKUP') && (
          <TouchableOpacity style={[s.commsBtn, checkedIn && {opacity: 0.55}]} activeOpacity={0.85}
            disabled={checkinBusy || checkedIn} onPress={() => void checkIn()}>
            <Icon name={checkedIn ? 'check-circle' : 'map-marker-account'} size={17} color={checkedIn ? D.signal : D.accentSoft} />
            <Text style={[s.commsText, checkedIn && {color: D.signal}]}>
              {checkedIn ? 'Checked in — in position' : checkinBusy ? 'Checking in…' : 'I’m in position'}
            </Text>
          </TouchableOpacity>
        )}

        {/* LM-C7 — crew fallback when the lead can't close a finished mission. */}
        {!isLead && (st === 'LIVE' || st === 'SOS') && (
          <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} disabled={reqBusy} onPress={requestCompletion}>
            <Icon name="flag-checkered" size={17} color={D.accentSoft} />
            <Text style={s.commsText}>{reqBusy ? 'Requesting…' : 'Request completion via agency'}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Floating SOS (PICKUP/LIVE) */}
      {showSos && (
        <TouchableOpacity style={[s.sosFab, {bottom: insets.bottom + (av.action !== 'none' ? 80 : 18)}]} activeOpacity={0.85}
          disabled={sosBusy} onPress={() => void raiseSos()}>
          {sosBusy ? <ActivityIndicator color="#fff" /> : <><Icon name="alarm-light" size={18} color="#fff" /><Text style={s.sosText}>SOS</Text></>}
        </TouchableOpacity>
      )}

      {/* Context-aware lead control (or read-only note for non-lead) */}
      <View style={[s.footer, {paddingBottom: insets.bottom + 14}]}>
        {av.action !== 'none' ? (
          <TouchableOpacity activeOpacity={0.85} disabled={acting} onPress={onAdvance}
            style={[s.advanceBtn, av.confirm && {backgroundColor: D.signal}, acting && {opacity: 0.6}]}>
            {acting ? <ActivityIndicator color="#fff" /> : (
              <><Icon name={av.action === 'finish' ? 'flag-checkered' : av.action === 'go-live' ? 'shield-check' : 'play'} size={19} color="#fff" />
                <Text style={s.advanceText}>{av.label}</Text></>
            )}
          </TouchableOpacity>
        ) : (
          <View style={s.readonly}>
            <Icon name={isLead ? 'check-circle-outline' : 'account-supervisor'} size={16} color={D.textMute} />
            <Text style={s.readonlyText}>{isLead ? 'No action right now' : 'Your team lead is advancing this mission'}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 10},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 22, paddingVertical: 16},
  accentBar: {width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 15, letterSpacing: 1, color: D.text},
  statusBadge: {fontFamily: D.fBold, fontSize: 11, letterSpacing: 1.2, color: D.signal},
  body: {paddingHorizontal: 22, paddingTop: 4, gap: 10},
  emptyIcon: {width: 80, height: 80, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair},
  emptyTitle: {fontFamily: D.fBold, fontSize: 18, color: D.text, marginTop: 6},
  emptySub: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', lineHeight: 19, maxWidth: 250},
  card: {borderRadius: 16, padding: 15, gap: 9, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  cardRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  cardVal: {flex: 1, fontFamily: D.fSemi, fontSize: 13.5, color: D.text, lineHeight: 19},
  cardSub: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, lineHeight: 18},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginTop: 8, marginLeft: 2},
  crewRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair},
  crewRowMe: {borderColor: 'rgba(91,141,239,0.3)', backgroundColor: 'rgba(91,141,239,0.06)'},
  crewName: {flex: 1, fontFamily: D.fBold, fontSize: 13.5, color: D.text},
  youTag: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 0.8, color: D.accentSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(91,141,239,0.14)'},
  crewRole: {fontFamily: D.fSemi, fontSize: 9.5, letterSpacing: 0.8, color: D.textMute},
  wpRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.015)'},
  wpText: {fontFamily: D.fBold, fontSize: 12, color: D.textDim, width: 80},
  wpEvent: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textMute},
  navBtn: {flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  navBtnText: {fontFamily: D.fBold, fontSize: 14.5, color: '#fff', letterSpacing: 0.3},
  commsBtn: {flexDirection: 'row', gap: 8, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  commsText: {fontFamily: D.fBold, fontSize: 14, color: D.accentSoft},
  sosFab: {position: 'absolute', right: 22, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 48, borderRadius: 999,
    backgroundColor: D.alert, shadowColor: D.alert, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 4}, elevation: 8},
  sosText: {fontFamily: D.fBold, fontSize: 14, letterSpacing: 0.5, color: '#fff'},
  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 22, paddingTop: 12, borderTopWidth: 1, borderTopColor: D.hair, backgroundColor: D.bg},
  advanceBtn: {flexDirection: 'row', gap: 9, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  advanceText: {fontFamily: D.fBold, fontSize: 15.5, color: '#fff', letterSpacing: 0.3},
  readonly: {flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', height: 48},
  readonlyText: {fontFamily: D.fSemi, fontSize: 13, color: D.textMute},
  // F3 — arrival-code card
  verifyCard: {borderRadius: 16, padding: 14, gap: 6, backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  verifyTitle: {fontFamily: D.fSemi, fontSize: 12, color: D.text},
  verifyCode: {fontFamily: D.fBold, fontSize: 26, letterSpacing: 6, color: D.accentSoft, textAlign: 'center', paddingVertical: 2},
}));
