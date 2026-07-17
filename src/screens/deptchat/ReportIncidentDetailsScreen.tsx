import React, {useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput,
  TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {launchCamera, launchImageLibrary} from 'react-native-image-picker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import type {AgentStackParamList} from '@navigation/types';
import {incidentApi} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton} from './_obsidian';
import {INCIDENT_CATEGORY_META, severityColor, INCIDENT_SEVERITIES} from './incidentMeta';
import {getGeo, reverseGeocode} from './geo';
import {uploadAndSealEvidence, type EvidenceResult} from './incidentEvidence';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'ReportIncidentDetails'>;

const MAX = 5000;

export default function ReportIncidentDetailsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const cat = INCIDENT_CATEGORY_META[params.category];
  const sevColor = severityColor(params.severity);
  const sevLabel = INCIDENT_SEVERITIES.find(s => s.key === params.severity)?.label ?? params.severity;

  const [description, setDescription] = useState('');
  const [coords, setCoords] = useState<{lat: number; lng: number; label: string} | null>(null);
  // PDF p.12 — manual site entry when location permission is denied/unavailable.
  const [manualLabel, setManualLabel] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [photo, setPhoto] = useState<{uri: string; mime: string} | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  const runPicker = async (src: 'camera' | 'library') => {
    try {
      // Read by uri (NOT includeBase64): a multi-MB base64 string held in screen
      // state was enough to get the host activity reclaimed under memory pressure
      // on low-RAM devices, "refreshing" the in-progress report. We read the
      // file's bytes only at upload time (incidentEvidence → readUriBytes).
      const opts = {mediaType: 'photo' as const, quality: 0.7 as const, maxWidth: 1600, maxHeight: 1600};
      const res = src === 'camera'
        ? await launchCamera({...opts, saveToPhotos: false})
        : await launchImageLibrary(opts);
      if (res.didCancel) {return;}
      const asset = res.assets?.[0];
      if (!asset?.uri) {return;}
      setPhoto({uri: asset.uri, mime: asset.type ?? 'image/jpeg'});
    } catch {
      Alert.alert('Photo', 'Could not open the camera or library on this device.');
    }
  };

  const pickPhoto = () => {
    // PDF p.12 — optional, and only where safe & lawful.
    Alert.alert('Photo evidence', 'Attach a photo only where it is safe and lawful to do so.', [
      {text: 'Take photo', onPress: () => { void runPicker('camera'); }},
      {text: 'Choose from library', onPress: () => { void runPicker('library'); }},
      {text: 'Cancel', style: 'cancel'},
    ]);
  };

  const captureLocation = async () => {
    if (locBusy) {return;}
    setLocBusy(true);
    try {
      const geo = await getGeo();
      if (geo) {
        // Reverse-geocode to a readable address so the manager sees a place,
        // not raw coordinates. Falls back to a generic label on a geocode miss.
        const label = await reverseGeocode(geo.lat, geo.lng);
        setCoords({lat: geo.lat, lng: geo.lng, label: label ?? 'Current location'});
        setManualOpen(false);
      } else {
        // PDF p.12 — offer the manual site fallback instead of a dead end.
        setManualOpen(true);
        Alert.alert('Location', 'Location was not shared. You can type the site manually, or submit without it.');
      }
    } finally {
      setLocBusy(false);
    }
  };

  const submit = async () => {
    if (busy) {return;}
    const text = description.trim();
    if (!text) {
      Alert.alert('Report Incident', 'Please add a short description of what happened.');
      return;
    }
    setBusy(true);
    try {
      const {data} = await incidentApi.submit({
        category: params.category,
        severity: params.severity,
        description: text,
        ...(coords
          ? {location_label: coords.label, location_lat: coords.lat, location_lng: coords.lng}
          : manualLabel.trim()
            ? {location_label: manualLabel.trim().slice(0, 120)}
            : {}),
      });
      const go = () => navigation.replace('IncidentSubmitted', {ref: data.ref, status: data.status, severity: data.severity});
      // Optional E2EE photo evidence (Step 10). The report itself already
      // succeeded, so a failed/partial attach never blocks it — but we no longer
      // hide the failure: if the photo didn't upload or couldn't be sealed for a
      // viewer, the submitter is told so they can retry instead of assuming it
      // attached silently.
      if (photo) {
        const ev: EvidenceResult = await uploadAndSealEvidence(data.id, photo.uri, photo.mime)
          .catch(() => ({attached: false, sealedFor: 0, reason: 'upload-failed' as const}));
        if (!ev.attached || ev.sealedFor === 0) {
          Alert.alert(
            'Report submitted',
            ev.attached
              ? 'Your report was sent, but the photo could not be secured for your manager to open. You can re-open the report and add it again.'
              : 'Your report was sent, but the photo could not be uploaded. You can re-open the report and add it again.',
            [{text: 'OK', onPress: go}],
          );
          return;
        }
      }
      go();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Report Incident', msg ?? (e as Error).message ?? 'Could not submit. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Report Incident" onBack={() => navigation.goBack()} pill="STEP 2" />

      <KeyboardAvoidingView style={{flex: 1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

          {/* Selection summary */}
          <Card style={s.summary}>
            <View style={s.sumLeft}>
              <Icon name={cat.icon} size={20} color={OB.glow} />
              <Text style={s.sumText} numberOfLines={1}>{cat.label}</Text>
            </View>
            <View style={[s.sevChip, {backgroundColor: sevColor + '1A', borderColor: sevColor + '4D'}]}>
              <View style={[s.sevDot, {backgroundColor: sevColor}]} />
              <Text style={[s.sevChipText, {color: sevColor}]}>{sevLabel}</Text>
            </View>
          </Card>

          <View style={{marginTop: 20}}>
            <SectionLabel>WHAT HAPPENED</SectionLabel>
            <View style={s.inputWrap}>
              <TextInput
                style={s.input}
                value={description}
                onChangeText={t => setDescription(t.slice(0, MAX))}
                placeholder="Describe the incident — what, where, who was involved, and any action taken."
                placeholderTextColor={OB.textMute}
                multiline
                textAlignVertical="top"
              />
              <Text style={s.counter}>{description.length}/{MAX}</Text>
            </View>
          </View>

          <View style={{marginTop: 18}}>
            <SectionLabel>ATTACHMENTS · OPTIONAL</SectionLabel>
            <TouchableOpacity style={s.attach} activeOpacity={0.8} onPress={() => { void captureLocation(); }}>
              <Icon name={coords ? 'map-marker-check' : 'map-marker-plus-outline'} size={20} color={coords ? OB.signal : OB.accentSoft} />
              <View style={{flex: 1}}>
                <Text style={s.attachTitle}>{coords ? 'Location attached' : locBusy ? 'Getting location…' : 'Attach my location'}</Text>
                <Text style={s.attachSub} numberOfLines={1}>
                  {coords ? coords.label : 'Captured once, only when you tap'}
                </Text>
              </View>
              {coords ? <Icon name="check-circle" size={18} color={OB.signal} /> : null}
            </TouchableOpacity>

            {/* Manual site fallback (PDF p.12 "use current location / select site"). */}
            {!coords && !manualOpen ? (
              <Text style={s.manualLink} onPress={() => setManualOpen(true)}>
                Or enter the site manually
              </Text>
            ) : null}
            {!coords && manualOpen ? (
              <View style={s.manualWrap}>
                <Icon name="map-marker-outline" size={18} color={OB.accentSoft} />
                <TextInput
                  style={s.manualInput}
                  value={manualLabel}
                  onChangeText={t => setManualLabel(t.slice(0, 120))}
                  placeholder="Site / area (e.g. Main Gate, Warehouse B)"
                  placeholderTextColor={OB.textMute}
                />
              </View>
            ) : null}

            {/* Photo evidence (Step 10) — encrypted on submit + sealed so only the
                org's managers (and you) can open it; never posted to any channel. */}
            {photo ? (
              <View style={[s.attach, {borderColor: 'rgba(74,222,128,0.34)', backgroundColor: 'rgba(74,222,128,0.05)'}]}>
                <Icon name="image-check-outline" size={20} color={OB.signal} />
                <View style={{flex: 1}}>
                  <Text style={s.attachTitle}>Photo attached</Text>
                  <Text style={s.attachSub} numberOfLines={1}>Encrypted on submit · managers can open it</Text>
                </View>
                <TouchableOpacity onPress={() => setPhoto(null)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="close-circle" size={18} color={OB.textMute} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={s.attach} activeOpacity={0.8} onPress={pickPhoto}>
                <Icon name="camera-plus-outline" size={20} color={OB.accentSoft} />
                <View style={{flex: 1}}>
                  <Text style={s.attachTitle}>Add photo evidence</Text>
                  <Text style={s.attachSub} numberOfLines={1}>Optional · encrypted, manager-only (only where safe & lawful)</Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[s.footer, {paddingBottom: insets.bottom + 12}]}>
        <PrimaryButton label="Submit Report" icon="send-check" busy={busy} onPress={() => { void submit(); }} />
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  summary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 6},
  sumLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  sumText: {flex: 1, color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  sevChip: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1},
  sevDot: {width: 8, height: 8, borderRadius: 4},
  sevChipText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '700', letterSpacing: 0.8},
  inputWrap: {
    borderRadius: 16, backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair2,
    padding: 14, minHeight: 150,
  },
  input: {flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 14, lineHeight: 20, minHeight: 110},
  counter: {alignSelf: 'flex-end', color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, marginTop: 6},
  attach: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: OB.hair,
  },
  attachTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  attachSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  manualLink: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5, paddingVertical: 8, paddingHorizontal: 4},
  manualWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
    backgroundColor: 'rgba(255,255,255,0.03)', paddingHorizontal: 14,
  },
  manualInput: {flex: 1, color: OB.text, fontFamily: BravoFont.regular, fontSize: 13, paddingVertical: 12},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
