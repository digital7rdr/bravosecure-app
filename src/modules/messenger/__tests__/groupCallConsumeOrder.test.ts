/**
 * BS-GC-CRASH regression — group call boot crashed on every JOINER with
 * "Cannot read property 'has' of undefined" at step 9 (the existing-
 * producer consume loop).
 *
 * Root cause was a source-ORDERING / temporal-dead-zone hazard: the boot
 * IIFE captured `const consumedProducerIds = consumedProducerIdsRef.current`
 * AFTER the step-9 loop that calls `consumeProducer`. On a host the loop is
 * empty (room just created) so it never fired; on a joiner the host's
 * producer already exists, so consumeProducer ran during step 9 and touched
 * the not-yet-initialised const → crash. The host never saw it.
 *
 * The fix reads `consumedProducerIdsRef.current` DIRECTLY at each use site
 * (no captured const), removing the ordering hazard. This test is a cheap
 * static guard: it reads the source and fails if the crashing pattern — a
 * `const consumedProducerIds = ...` alias used inside consumeProducer —
 * comes back. A full hook render test would need the entire mediasoup /
 * FrameCryptor / WS surface mocked, which is far more brittle than pinning
 * the one-line invariant that actually regressed.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {
  createEarlyProducerBuffer,
  type BufferedProducer,
} from '../webrtc/groupCallProducerBuffer';

const SRC = readFileSync(
  join(__dirname, '..', 'webrtc', 'useGroupCall.ts'),
  'utf8',
);

describe('useGroupCall — consume ordering (BS-GC-CRASH)', () => {
  it('does not capture consumedProducerIds into a const alias (TDZ hazard)', () => {
    // The crashing form. If this reappears, a joiner can touch the const
    // before its initialiser runs (step 9 precedes the declaration).
    expect(SRC).not.toMatch(/const\s+consumedProducerIds\s*=/);
  });

  it('reads consumedProducerIdsRef.current directly in the consume guard', () => {
    // The guard that runs first inside consumeProducer must hit the
    // always-initialised ref, not a possibly-uninitialised local.
    expect(SRC).toMatch(/if\s*\(\s*consumedProducerIdsRef\.current\.has\(producerId\)\s*\)\s*\{return;\}/);
  });

  it('still records a consumed producer via the ref after success', () => {
    expect(SRC).toMatch(/consumedProducerIdsRef\.current\.add\(producerId\)/);
  });
});

describe('B-06 — early new-producer buffer/drain', () => {
  const mk = (id: string): BufferedProducer => ({
    producerId:     id,
    participantTag: `tag-${id}`,
    kind:           'audio',
  });

  it('buffers events that arrive before recvTransport is ready', () => {
    let ready = false;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));
    buf.accept(mk('b'));

    // Nothing consumed while not ready — held in the queue instead.
    expect(consumed).toEqual([]);
    expect(buf.size()).toBe(2);
  });

  it('drains buffered events exactly once when ready, with no duplicate consume', () => {
    let ready = false;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));
    buf.accept(mk('b'));

    ready = true;
    buf.drain();

    expect(consumed).toEqual(['a', 'b']);
    expect(buf.size()).toBe(0);

    // A second drain replays nothing — each buffered descriptor forwards once.
    buf.drain();
    expect(consumed).toEqual(['a', 'b']);
  });

  it('consumes immediately once ready (no buffering on the steady-state path)', () => {
    let ready = true;
    const consumed: string[] = [];
    const buf = createEarlyProducerBuffer(() => ready, p => consumed.push(p.producerId));

    buf.accept(mk('a'));

    expect(consumed).toEqual(['a']);
    expect(buf.size()).toBe(0);
  });
});

describe('B-06 — early handler registration (static guard)', () => {
  it('registers the boot SFU frame handler before sfu.join', () => {
    // The actual call site (not the moved-comment) is `registerSfuHandler(rid, (frame) => {`.
    const earlyReg = SRC.indexOf('registerSfuHandler(rid, (frame)');
    const joinIdx  = SRC.indexOf("'sfu.join'");
    expect(earlyReg).toBeGreaterThan(-1);
    expect(joinIdx).toBeGreaterThan(-1);
    // The boot handler registration must precede sfu.join in source order.
    expect(earlyReg).toBeLessThan(joinIdx);
  });

  it('registers the boot SFU frame handler exactly once', () => {
    // The boot handler is keyed by `rid`; the separate resume re-register
    // path (Fix #7) is keyed by `opts.roomId`, so this counts only boot.
    const matches = SRC.match(/registerSfuHandler\(rid, \(frame\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('routes new-producer events through the early buffer', () => {
    expect(SRC).toMatch(/createEarlyProducerBuffer/);
    expect(SRC).toMatch(/earlyProducerBufferRef\.current\?\.accept\(/);
  });

  it('drains the early buffer after the consume pipeline is ready', () => {
    expect(SRC).toMatch(/earlyProducerBuffer\.drain\(\)/);
  });
});
