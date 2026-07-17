import type { Message as BaseMessage, Conversation as BaseConversation, MessageStatus } from '@appTypes/index';
import type { Ciphertext, SessionAddress } from '@bravo/messenger-core';

/**
 * Local-only message shape. Extends the shared API Message with
 * crypto-layer fields that never leave the device. `content` is
 * plaintext — the ciphertext field is kept for debug/replay only
 * and must NOT be passed to any logger.
 */
export interface LocalMessage extends BaseMessage {
  peer: SessionAddress;
  /**
   * Server-issued envelope id this message corresponds to. Set on
   * inbound messages (so we can ACK + send read-receipt by id) and
   * on outbound messages once `envelope.accepted` returns. Persisted
   * so receipts survive app restarts.
   */
  envelope_id?: string;
  /** Last ciphertext we produced/consumed for this message. Not persisted to disk. */
  ciphertext?: Ciphertext;
  /** epoch ms for disappearing messages (wired in M7, schema-ready now). */
  expires_at?: number;
  /** Reply/quote — id of the message being replied to (opaque client id). */
  reply_to_msg_id?: string;
  /** Plaintext preview of the quoted message, chosen by the sender. */
  reply_to_preview?: string;
  /**
   * Emoji reactions folded onto this message. Keyed by the reactor's
   * userId so multiple reactions from the same user replace, not
   * stack. `{'u-alice': '❤️', 'u-bob': '😂'}`.
   */
  reactions?: Record<string, string>;
  /**
   * Capability token returned by the relay on submit. Lets the sender
   * retract this envelope from the relay queue (e.g. on TTL expiry,
   * "delete for everyone"). Only present on outgoing messages —
   * recipients never see it. Stored locally; loss = wait for dwell.
   */
  retract_token?: string;
  /**
   * R2 object key when the message carries an attachment. Populated
   * on both inbound and outbound paths so the expiry sweeper, retract
   * flow, and conversation-clear handler can purge the corresponding
   * cached ciphertext blob. Without this, evicted messages would
   * orphan their cache entries. Never used as an auth token —
   * downloads still require the per-file AES key from the sealed
   * envelope.
   */
  media_object_key?: string;
  /**
   * Optional declared mime type for the attachment. The renderer uses
   * it to pick the right viewer (image / audio / pdf / generic file).
   * Carried inside the sealed payload as part of `attachment.mimeType`;
   * stored on the LocalMessage so the row remains self-describing
   * after a backup restore.
   */
  media_mime?: string;
  /**
   * Round 8 — per-file AES-256 key used to decrypt the encrypted blob
   * fetched from R2, base64. Without this, restored attachments are
   * unrecoverable ciphertext (the R2 object is plaintext-blind to us
   * by design). Previously the key only travelled inside the sealed
   * envelope and was consumed once at receive time, so on reinstall
   * every attachment became a broken-bubble. Mirrored alongside the
   * message ciphertext in the encrypted backup payload.
   *
   * Sender + recipient both populate this when present; the renderer
   * pairs it with `media_iv` to drive AES-CBC + HMAC-SHA256 decrypt.
   * Never sent in cleartext over the wire — only ever inside the
   * E2E-wrapped payload (live envelope) or AES-GCM-wrapped backup row.
   */
  media_key?: string;
  /**
   * Round 8 — per-file 16-byte IV for the AES-CBC attachment cipher,
   * base64. Pair of `media_key`. Same lifecycle — only ever inside
   * E2E-wrapped storage.
   */
  media_iv?: string;
  /**
   * Media-parity metadata (2026-07-03) carried in the sealed attachment
   * and persisted (media_meta_json, schema v13): display hints so the
   * bubble renders an instant preview with the right aspect ratio, a
   * real filename, and a duration label without touching the network.
   * `thumbB64` is a tiny sender-generated JPEG (≤~20 KB).
   */
  media_meta?: {
    name?:       string;
    width?:      number;
    height?:     number;
    durationMs?: number;
    thumbB64?:   string;
    sizeBytes?:  number;
  };
  /**
   * Call-record metadata when `type === 'call'`. Inserted by CallScreen
   * on call end so the conversation timeline shows incoming / outgoing /
   * missed / declined calls inline like WhatsApp does. Never sent over
   * the wire — purely a local UI artifact derived from CallScreen
   * lifecycle events.
   */
  call_meta?: {
    kind:      'voice' | 'video';
    direction: 'incoming' | 'outgoing';
    /**
     * Outcome derived from how the call ended.
     *   answered      — completed normally
     *   missed        — incoming, never picked up
     *   declined      — explicit decline
     *   failed        — connection failure
     *   ended-by-host — group call only: HOST left and the server
     *                   broadcast sfu.room.ended; this participant was
     *                   not the host. Renders as "Group call ended by
     *                   host" so the chat history matches what the
     *                   user just saw on screen instead of a generic
     *                   "Group voice call · 0:23".
     */
    outcome:   'answered' | 'missed' | 'declined' | 'failed' | 'ended-by-host';
    /** Duration in seconds. 0 for missed / declined. */
    duration:  number;
    /**
     * True when the bubble represents a group SFU call (not 1:1).
     * Tapping a group bubble should re-launch a group call via
     * `launchCall(...)`'s isGroupConversation branch rather than the
     * 1:1 CallScreen, and the row label includes a participant count
     * placeholder ("Group voice call · 3:42").
     */
    groupCall?: boolean;
  };
}

export interface LocalConversation extends BaseConversation {
  peer: SessionAddress;
  /**
   * Peer's phone in E.164, captured at contact discovery / chat creation.
   * Display-only (Chat Info "number under name"); the server's profile
   * endpoint deliberately never exposes phones, so this is the only source.
   */
  phoneE164?: string;
  /** Non-empty while the Signal session is being established / recovered. */
  session_state: 'fresh' | 'established' | 'error';
  /** Pinned rows float to the top of the chat list. Local-only for v1. */
  is_pinned?: boolean;
  /**
   * Default disappearing-message TTL (seconds) applied to every NEW
   * outgoing message in this conversation. Null = off. Per-message
   * overrides from the composer still win. Group chats use this to
   * enforce a shared burn window.
   */
  default_ttl_sec?: number | null;
  /**
   * Audit fix #33 — true when the user explicitly renamed this
   * conversation through the chat-info screen. The contact-discovery
   * sweep checks this flag before overwriting the conversation name
   * with the address-book label. Without this, a chat the user
   * renamed "Mom 🌸" would silently revert to "Sahana Begum"
   * (her registered Bravo name) the next time contact-sync ran.
   */
  is_custom_name?: boolean;
}

export type { MessageStatus };
