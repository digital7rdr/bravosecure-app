/**
 * 02 / 09 — Registration Wizard
 *
 * 4-step wizard (Company · Contact · Creds · Review). All fields save to
 * the backend via `agentApi.updateCompany()` — nothing is hardcoded.
 * On Submit → triggers KYC start + navigates to AgentKYC.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, TouchableOpacity, StatusBar, StyleSheet,
  TextInput, BackHandler } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, ProgressRail, CTAButton, SectionLabel} from './_shared';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {agentApi} from '@services/api';
import {extractMsg} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type StepId = 'company' | 'contact' | 'creds' | 'review';
const STEPS: {id: StepId; label: string}[] = [
  {id: 'company', label: 'Company'},
  {id: 'contact', label: 'Contact'},
  {id: 'creds',   label: 'Creds'},
  {id: 'review',  label: 'Review'},
];

const CAPABILITY_DEFS: {key: string; label: string}[] = [
  {key: 'first_aid', label: 'First Aid / Trauma Care'},
  {key: 'firearms',  label: 'Firearms Certified'},
  {key: 'driving',   label: 'Defensive Driving · Level 2'},
  {key: 'recon',     label: 'Route Recon / SIGINT'},
  {key: 'medical',   label: 'Medical / FREC-3'},
];

export default function AgentRegistrationWizardScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [step, setStep] = useState<StepId>('company');
  const [busy, setBusy] = useState(false);

  // Company/contact fields — all user-editable, persisted to the backend.
  const [legalName, setLegalName]     = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [regulator, setRegulator]     = useState('');
  const [established, setEstablished] = useState('');
  const [primaryContact, setPrimaryContact] = useState('');
  const [primaryEmail, setPrimaryEmail]     = useState('');
  const [primaryPhone, setPrimaryPhone]     = useState('');
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({
    first_aid: false, firearms: false, driving: false, recon: false, medical: false,
  });

  // Hydrate from the server on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await agentApi.getMe();
        if (cancelled) {return;}
        const c = (data.profile.company ?? {}) as Record<string, string>;
        const contact = (data.profile.contact ?? {}) as Record<string, string>;
        const caps = (data.profile.capabilities ?? []) as string[];
        setLegalName(c.legal_name ?? '');
        setCompanyNumber(c.company_number ?? '');
        setRegulator(c.regulator ?? '');
        setEstablished(c.established ?? '');
        setPrimaryContact(contact.primary_contact ?? '');
        setPrimaryEmail(contact.primary_email ?? '');
        setPrimaryPhone(contact.primary_phone ?? '');
        setCapabilities(CAPABILITY_DEFS.reduce((acc, def) => {
          acc[def.key] = caps.includes(def.key);
          return acc;
        }, {} as Record<string, boolean>));
      } catch { /* first-time agent has blank defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const stepIndex = STEPS.findIndex(x => x.id === step);
  const isLast = step === 'review';

  // Persist the current set of fields before advancing.
  const saveToServer = async () => {
    const payload = {
      legal_name:     legalName.trim(),
      company_number: companyNumber.trim(),
      regulator:      regulator.trim(),
      established:    established.trim(),
      primary_contact: primaryContact.trim(),
      primary_email:   primaryEmail.trim(),
      primary_phone:   primaryPhone.trim(),
      capabilities:   Object.entries(capabilities).filter(([_, on]) => on).map(([k]) => k),
    };
    await agentApi.updateCompany(payload);
  };

  const onCta = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      await saveToServer();
      if (isLast) {
        // Skip the standalone KYC screen — the compliance-pack upload
        // (AgentDocsUpload) collects everything in one place. The
        // backend auto-settles the 4 KYC checks and mirrors any
        // already-uploaded KYC files into the doc slots.
        //
        // Why no catch: skipKyc is idempotent server-side (a no-op once the
        // agent is at DOCS_PENDING or past), so a throw here is a genuine
        // failure, not a replay. Swallowing it advanced the agent to a screen
        // whose door had never opened, stranding them at PROFILE_COMPLETE with
        // a full doc pack and an un-submittable application (B-96).
        await agentApi.skipKyc();
        navigation.navigate('AgentCoverage');
        return;
      }
      setStep(STEPS[stepIndex + 1].id);
    } catch (e: unknown) {
      Alert.alert('Could not save', extractMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleCap = (key: string) =>
    setCapabilities(prev => ({...prev, [key]: !prev[key]}));

  // B-98a — back steps the INTERNAL wizard first; at the first internal step
  // it pops the route when there is one. Resume entry (status DRAFT) replaces
  // AgentTypeSelect with this screen, so the stack can be empty — falling back
  // to AgentTypeSelect would just bounce off its status auto-forward, so hide
  // the chevron instead (NavHeader renders a spacer for undefined onBack).
  const canPop = navigation.canGoBack();
  const handleBack = stepIndex > 0
    ? () => setStep(STEPS[stepIndex - 1].id)
    : (canPop ? () => navigation.goBack() : undefined);

  // B-98a — hardware back mirrors the chevron; when the chevron is hidden
  // (empty stack at the first internal step) fall through to the default
  // (background the app — standard Android root behaviour).
  const handleBackRef = React.useRef(handleBack);
  handleBackRef.current = handleBack;
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const h = handleBackRef.current;
      if (h) {h(); return true;}
      return false;
    });
    return () => sub.remove();
  }, []));

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader
        title="Agent Registration"
        onBack={handleBack}
        stepPill={`${stepIndex + 1}/4`}
      />
      <ProgressRail total={4} active={stepIndex + 1} />

      <KeyboardAvoidingScreen contentContainerStyle={s.scroll}>

        <View style={s.tabRow}>
          {STEPS.map(st => {
            const on = st.id === step;
            return (
              <TouchableOpacity
                key={st.id}
                style={[s.tabChip, on && s.tabChipOn]}
                onPress={() => setStep(st.id)}
                activeOpacity={0.85}>
                <Text style={[s.tabChipText, on && s.tabChipTextOn]}>{st.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {step === 'company' && (
          <>
            <SectionLabel>Company Details</SectionLabel>
            <Field label="Legal Name"     value={legalName}     onChange={setLegalName} placeholder="UK Close Protection Ltd." />
            <Field label="Company Number" value={companyNumber} onChange={setCompanyNumber} placeholder="SIA-2024-CP-441" />
            <Field label="Established (DD/MM/YYYY)" value={established} onChange={setEstablished} placeholder="11/06/2017" />
            <Field label="Regulator" value={regulator} onChange={setRegulator} placeholder="UK Security Industry Authority" selected />
          </>
        )}

        {step === 'contact' && (
          <>
            <SectionLabel>Primary Contact</SectionLabel>
            <Field label="Contact Name"  value={primaryContact} onChange={setPrimaryContact} placeholder="Marcus Thornton" />
            <Field label="Email"         value={primaryEmail}   onChange={setPrimaryEmail}   placeholder="m.thornton@ukcp.co.uk" keyboardType="email-address" />
            <Field label="Phone"         value={primaryPhone}   onChange={setPrimaryPhone}   placeholder="+44 7911 234567" keyboardType="phone-pad" />
          </>
        )}

        {step === 'creds' && (
          <>
            <SectionLabel>Operational Capabilities</SectionLabel>
            {CAPABILITY_DEFS.map(def => {
              const on = capabilities[def.key];
              return (
                <TouchableOpacity
                  key={def.key}
                  style={[s.check, on && s.checkOn]}
                  onPress={() => toggleCap(def.key)}
                  activeOpacity={0.85}>
                  <View style={[s.cbox, on && s.cboxOn]}>
                    {on && <Icon name="check" size={12} color="#fff" />}
                  </View>
                  <Text style={s.checkText}>{def.label}</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {step === 'review' && (
          <>
            <SectionLabel>Review</SectionLabel>
            <ReviewRow k="Legal name"   v={legalName} />
            <ReviewRow k="Reg. number"  v={companyNumber} />
            <ReviewRow k="Regulator"    v={regulator} />
            <ReviewRow k="Established"  v={established} />
            <ReviewRow k="Contact"      v={primaryContact} />
            <ReviewRow k="Email"        v={primaryEmail} />
            <ReviewRow k="Phone"        v={primaryPhone} />
            <ReviewRow
              k="Capabilities"
              v={Object.entries(capabilities).filter(([_,on]) => on).map(([k]) => k).join(', ') || '—'}
            />
            <Text style={s.reviewNote}>Submitting will lock company details and start KYC checks.</Text>
          </>
        )}
      </KeyboardAvoidingScreen>

      <CTAButton
        label={busy ? 'Saving…' : (isLast ? 'Submit · Start KYC' : `Next · ${STEPS[stepIndex + 1]?.label ?? ''}`)}
        onPress={() => { void onCta(); }}
        variant={busy ? 'disabled' : 'primary'}
      />
    </View>
  );
}

function Field({
  label, value, onChange, placeholder, selected, keyboardType,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; selected?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
}) {
  return (
    <View style={f.col}>
      <Text style={f.label}>{label}</Text>
      <View style={[f.input, selected && f.inputSel]}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={Colors.textMuted}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize={keyboardType === 'email-address' ? 'none' : 'words'}
          style={f.textInput}
        />
      </View>
    </View>
  );
}

function ReviewRow({k, v}: {k: string; v: string}) {
  return (
    <View style={r.row}>
      <Text style={r.k}>{k}</Text>
      <Text style={r.v}>{v || '—'}</Text>
    </View>
  );
}


const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  tabRow: {
    flexDirection: 'row', gap: 6, padding: 3, borderRadius: 8,
    backgroundColor: Colors.surfaceOverlay, borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  tabChip: {flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center'},
  tabChipOn: {
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.25, shadowRadius: 10,
    shadowOffset: {width: 0, height: 4},
  },
  tabChipText: {
    fontFamily: BravoFont.bold, fontSize: 9, letterSpacing: 1.2,
    color: Colors.textMuted, textTransform: 'uppercase',
  },
  tabChipTextOn: {color: '#fff'},

  check: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 10, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  checkOn: {},
  cbox: {
    width: 18, height: 18, borderRadius: 5,
    borderWidth: 1.5, borderColor: Colors.borderDefault,
    alignItems: 'center', justifyContent: 'center',
  },
  cboxOn: {
    backgroundColor: Colors.primary, borderColor: Colors.primary,
    shadowColor: Colors.primary, shadowOpacity: 0.35, shadowRadius: 10,
    shadowOffset: {width: 0, height: 0},
  },
  checkText: {
    flex: 1, fontSize: 12, color: Colors.textPrimary, fontWeight: '500',
  },
  reviewNote: {
    fontSize: 10.5, color: Colors.textMuted, marginTop: 10, lineHeight: 14,
    fontStyle: 'italic',
  },
}));

const f = StyleSheet.create(scaleTextStyles({
  col: {gap: 5},
  label: {
    fontFamily: BravoFont.bold, fontSize: 9.5, letterSpacing: 1.4,
    color: Colors.textMuted, textTransform: 'uppercase',
  },
  input: {
    paddingHorizontal: 11, paddingVertical: 2, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    flexDirection: 'row', alignItems: 'center', minHeight: 38,
  },
  inputSel: {borderColor: Colors.primary},
  textInput: {
    flex: 1, fontSize: 12.5, color: Colors.textPrimary, padding: 0, margin: 0,
  },
}));

const r = StyleSheet.create(scaleTextStyles({
  row: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  k: {
    fontFamily: BravoFont.bold, fontSize: 10, letterSpacing: 1.2,
    color: Colors.textMuted, textTransform: 'uppercase',
  },
  v: {
    flex: 1, fontSize: 12, color: Colors.textPrimary, textAlign: 'right',
  },
}));
