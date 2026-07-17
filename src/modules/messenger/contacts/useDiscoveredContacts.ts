import {useCallback, useEffect, useState} from 'react';
import * as Contacts from 'expo-contacts';
import {normalizeBatch, regionFromOwnPhone, type CountryCode} from './phoneNormalize';
import type {DiscoveredContact, UsersHttpClient} from '@bravo/messenger-core';
import {useMessengerStore} from '../store';

/**
 * Permission state surfaced to the UI — `unknown` on first mount before
 * we've asked, `granted`/`denied` after the prompt, `unavailable` on
 * environments where expo-contacts can't run (web, jest). `denied` is
 * terminal from this hook's perspective; UI offers a "Open Settings"
 * escape hatch.
 */
export type ContactsPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';

/**
 * Internal row shape after pairing a device contact with a Bravo match.
 * `phoneE164` is the normalized form we queried with; `raw` is the
 * original string so UI can fall back to it if the server ever omits
 * the phone (it doesn't today, but belt-and-suspenders).
 */
export interface DiscoveredRow {
  userId:      string;
  displayName: string;
  avatarUrl:   string | null;
  phoneE164:   string;
  /** Local contact name from the address book — usually what the user calls them. */
  localName:   string;
}

export interface UseDiscoveredContactsResult {
  permission: ContactsPermission;
  loading:    boolean;
  error:      string | null;
  matches:    DiscoveredRow[];
  /** Kick (or re-kick) the permission prompt + lookup. Idempotent. */
  refresh:    () => Promise<void>;
}

interface Options {
  /** UsersHttpClient for the /users/lookup call — omit to skip the server round-trip. */
  users:      UsersHttpClient | null;
  /**
   * The signed-in user's own phone. Used to infer the default country
   * code so local-format numbers in the address book (no `+`, no
   * country prefix) can be parsed.
   */
  ownPhoneE164?: string | null;
  /**
   * Hard-coded country calling code (e.g. "1" for US, "44" for GB).
   * Takes precedence over `ownPhoneE164`. Handy for tests and for
   * users whose own phone lives in a different country from their
   * contacts.
   */
  defaultRegion?: CountryCode;
  /** Skip the prompt + read when false — lets screens wait for user intent. */
  enabled?: boolean;
  /**
   * WhatsApp-style background sync. When true, the hook only runs the
   * directory lookup if contacts permission is ALREADY granted —
   * `getPermissionsAsync()` instead of `requestPermissionsAsync()`. No
   * system prompt is ever shown; if permission is missing, the hook is
   * a silent no-op. Used by MessengerHomeScreen so chats from saved
   * contacts auto-rename their UUID-prefix placeholder ("abc12345") to
   * the user's saved contact label ("Alice") on every app open,
   * mirroring WhatsApp's behaviour of silently keeping the address-book
   * ↔ directory pairing fresh in the background. Foreground screens
   * (NewChatScreen) leave this off so they can still drive the initial
   * permission prompt.
   */
  passive?: boolean;
}

/**
 * React hook that executes the full "contacts on Bravo" flow:
 *   1. Request contacts permission
 *   2. Read the device address book
 *   3. Normalize every phone string to E.164 (libphonenumber-js,
 *      defaulting the region off the caller's own phone)
 *   4. POST the E.164 list to /users/lookup
 *   5. Pair each server match back to its local contact so we can
 *      show the USER'S NAME for the contact rather than the
 *      display_name Bravo has on file (people name their contacts
 *      their own way — "Mom", "Boss", etc).
 *
 * The hook owns no navigation concerns; callers decide how to render.
 */
export function useDiscoveredContacts(opts: Options): UseDiscoveredContactsResult {
  const {users, ownPhoneE164, defaultRegion, enabled = true, passive = false} = opts;

  const [permission, setPermission] = useState<ContactsPermission>('unknown');
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [matches,    setMatches]    = useState<DiscoveredRow[]>([]);

  const region = defaultRegion ?? regionFromOwnPhone(ownPhoneE164);

  const run = useCallback(async () => {
    if (!enabled) {return;}
    setError(null);

    if (!isContactsAvailable()) {
      setPermission('unavailable');
      return;
    }

    setLoading(true);
    try {
      // Passive callers (background-sync from Home) MUST NOT trigger a
      // system permission prompt — only act on previously-granted
      // permission. Foreground callers (NewChatScreen) prompt as usual.
      const perm = passive
        ? await Contacts.getPermissionsAsync()
        : await Contacts.requestPermissionsAsync();
      if (perm.status !== Contacts.PermissionStatus.GRANTED) {
        // In passive mode a `denied` status just means "not granted yet";
        // surface as `unknown` so a UI gating off `permission === 'denied'`
        // (e.g. NewChatScreen's settings-prompt block) doesn't flip to
        // the denial state purely because the background sweep ran first.
        setPermission(passive ? 'unknown' : 'denied');
        setLoading(false);
        return;
      }
      setPermission('granted');

      const {data} = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
        pageSize: 0, // 0 === no pagination — return everything
      });

      // Build a phone→localName map so we can pair server matches back
      // to the user's own contact labels.
      const phoneToLocalName = new Map<string, string>();
      for (const c of data) {
        const name = (c.name ?? '').trim() || phoneFallback(c);
        for (const p of c.phoneNumbers ?? []) {
          const raw = p.number ?? p.digits;
          const e164 = normalizeSingle(raw, region);
          if (!e164) {continue;}
          // First entry wins — contacts with multiple numbers under the
          // same E.164 are rare, and the order is address-book order
          // which is what the user would expect.
          if (!phoneToLocalName.has(e164)) {phoneToLocalName.set(e164, name);}
        }
      }

      if (phoneToLocalName.size === 0 || !users) {
        setMatches([]);
        setLoading(false);
        return;
      }

      const phones = Array.from(phoneToLocalName.keys());
      // Server caps each /users/lookup at 500 phones (auth-service
      // ArrayMaxSize). Address books with more than 500 entries — common
      // on long-lived devices — would otherwise fail validation with
      // "phones must contain no more than 500 elements". Batch into
      // 500-sized chunks and merge.
      const BATCH_SIZE = 500;
      const serverMatches: DiscoveredContact[] = [];
      for (let i = 0; i < phones.length; i += BATCH_SIZE) {
        const chunk = phones.slice(i, i + BATCH_SIZE);
        const chunkMatches = await users.lookup(chunk);
        serverMatches.push(...chunkMatches);
      }

      const rows: DiscoveredRow[] = serverMatches.map((m: DiscoveredContact) => ({
        userId:      m.userId,
        displayName: m.displayName,
        avatarUrl:   m.avatarUrl,
        phoneE164:   m.phone,
        localName:   phoneToLocalName.get(m.phone) ?? m.displayName,
      }));
      // Sort by the user's local label — matches how the UI expects to
      // read the list; ASCII sort is fine for MVP.
      rows.sort((a, b) => a.localName.localeCompare(b.localName));
      setMatches(rows);

      // Patch any auto-created conversations that were sitting with a
      // placeholder name ("Bravo · abcd1234") because the peer messaged
      // us before we'd run contact sync. Now that we know who they are,
      // upgrade the name to the user's local contact label.
      //
      // Audit fix #33 — never overwrite a name the user customised.
      // `is_custom_name` is set whenever the user renames a conversation
      // through the chat-info screen; we honour that here so the
      // discovery sweep doesn't silently revert "Mom" to her registered
      // Bravo display name.
      const store = useMessengerStore.getState();
      // Index every direct row by peer userId — covers both the synthetic
      // `direct:<peer>` id AND the canonical server-UUID rows (B-18 merge),
      // which the old `direct:` lookup silently skipped.
      const byPeer = new Map<string, string[]>();
      for (const c of Object.values(store.conversations)) {
        if (c.type === 'direct' && c.peer?.userId) {
          const list = byPeer.get(c.peer.userId) ?? [];
          list.push(c.id);
          byPeer.set(c.peer.userId, list);
        }
      }
      for (const r of rows) {
        for (const cid of byPeer.get(r.userId) ?? []) {
          const existing = store.conversations[cid];
          if (!existing) {continue;}
          const upgradeName  = existing.name !== r.localName && !existing.is_custom_name;
          const upgradePhone = !!r.phoneE164 && existing.phoneE164 !== r.phoneE164;
          if (upgradeName || upgradePhone) {
            store.upsertConversation({
              ...existing,
              ...(upgradeName ? {name: r.localName} : null),
              ...(upgradePhone ? {phoneE164: r.phoneE164} : null),
            });
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'contact_lookup_failed');
    } finally {
      setLoading(false);
    }
  }, [enabled, region, users]);

  useEffect(() => {
    void run();
  }, [run]);

  return {permission, loading, error, matches, refresh: run};
}

function isContactsAvailable(): boolean {
  return typeof Contacts.requestPermissionsAsync === 'function';
}

function phoneFallback(c: Contacts.Contact): string {
  const n = c.phoneNumbers?.[0]?.number ?? c.phoneNumbers?.[0]?.digits ?? '';
  return n || 'Unknown';
}

/** Thin wrapper over normalizeBatch for a single entry — keeps the loop above tidy. */
function normalizeSingle(raw: string | undefined, callingCode: string | undefined): string | null {
  const batch = normalizeBatch([raw ?? null], callingCode);
  return batch[0] ?? null;
}
