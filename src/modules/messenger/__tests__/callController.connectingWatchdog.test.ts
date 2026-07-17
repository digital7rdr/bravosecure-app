/**
 * B-62 — 'connecting' watchdog. Both 2026-07-10 Pixel-7a failed answers
 * wedged in 'connecting' forever: the ring timer is cancelled at accept
 * and the reconnect budget only arms after a first connect, so a lost
 * call.answer left no timer at all. The watchdog (armed on the
 * 'connecting' transition) must end the call as failed — which drives
 * every teardown path (FGS notif, InCallManager, registry) — and must
 * NOT fire once the call reaches 'connected' or ends cleanly.
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

function fakeTransport() {
  const sent: ClientFrame[] = [];
  return {
    sent,
    transport: {
      state: 'connected',
      send: (f: ClientFrame) => { sent.push(f); },
    } as unknown as TransportClient,
  };
}

type MutablePeer = PeerConnectionLike & {iceConnectionState?: string};

function fakePeer(): MutablePeer {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: sdp('offer')}),
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => {},
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => new Map<string, StatsReport>([
      ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
      ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

const PEER_BOB = {userId: 'bob', deviceId: 1};

function build(opts: {connectingWatchdogMs?: number} = {}) {
  const {sent, transport} = fakeTransport();
  const signalling = new CallSignalling(transport);
  const peers: MutablePeer[] = [];
  const pcFactory: PeerConnectionFactory = () => {
    const p = fakePeer();
    peers.push(p);
    return p;
  };
  const states: string[] = [];
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState:       s => states.push(s),
    onMissedCall:  jest.fn(),
    ringTimeoutMs: 60_000,
    connectingWatchdogMs: opts.connectingWatchdogMs ?? 1000,
  });
  return {controller, signalling, sent, states, peers};
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {await Promise.resolve();}
}

describe('B-62 — CallController connecting watchdog', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it('callee stuck in connecting after accept() → hangup(failed) + state failed', async () => {
    const {controller, sent, states} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-1', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');
    expect(sent.find(f => f.event === 'call.answer')).toBeDefined();

    // No ICE ever connects. The watchdog must end the call.
    jest.advanceTimersByTime(1000);
    await flush();

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect((hangup as {data: {reason: string}}).data.reason).toBe('failed');
    expect(states).toContain('failed');
  });

  it('caller stuck in connecting after answer → watchdog fires', async () => {
    const {controller, signalling, sent, states} = build({connectingWatchdogMs: 1000});
    await controller.startOutgoing({callId: 'c-wd-2', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-wd-2', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    expect(states).toContain('connecting');

    jest.advanceTimersByTime(1000);
    await flush();

    const hangup = sent.find(f => f.event === 'call.hangup');
    expect(hangup).toBeDefined();
    expect(states).toContain('failed');
  });

  it('ICE connected before the deadline cancels the watchdog', async () => {
    const {controller, sent, states, peers} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-3', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');

    // Simulate the ICE agent connecting at 500 ms.
    jest.advanceTimersByTime(500);
    const peer = peers[peers.length - 1];
    peer.iceConnectionState = 'connected';
    (peer.oniceconnectionstatechange as unknown as (() => void) | null)?.();
    await flush();
    expect(states).toContain('connected');

    // Run well past the original deadline — no failure, no hangup.
    jest.advanceTimersByTime(5000);
    await flush();
    expect(sent.find(f => f.event === 'call.hangup')).toBeUndefined();
    expect(states).not.toContain('failed');
    controller.hangup();
  });

  it('watchdog promotes instead of failing when ICE is connected but the event was missed', async () => {
    const {controller, sent, states, peers} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-5', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    expect(states).toContain('connecting');

    // ICE agent connected, but the statechange event never fired (cold-answer
    // double-mount race) — the watchdog must promote, not kill a live call.
    const peer = peers[peers.length - 1];
    peer.iceConnectionState = 'connected';
    jest.advanceTimersByTime(1000);
    await flush();

    expect(states).toContain('connected');
    expect(sent.find(f => f.event === 'call.hangup')).toBeUndefined();
    expect(states).not.toContain('failed');
    controller.hangup();
  });

  it('clean hangup before the deadline leaves no stray watchdog', async () => {
    const {controller, sent, states} = build({connectingWatchdogMs: 1000});
    controller.handleIncomingOffer({callId: 'c-wd-4', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    controller.hangup();
    await flush();

    jest.advanceTimersByTime(5000);
    await flush();

    const hangups = sent.filter(f => f.event === 'call.hangup');
    expect(hangups).toHaveLength(1);
    expect((hangups[0] as {data: {reason: string}}).data.reason).toBe('ended');
    expect(states).not.toContain('failed');
  });
});
