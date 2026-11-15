import { useEffect, useState } from 'react';

import {
  CHARACTER_SLOTS,
  type CharacterProfile,
  newCharacterId,
  parseCharacterProfiles,
} from '../../../../vendor/pixel-agents/core/src/characterProfiles.js';
import { DEFAULT_CHARACTER_PROFILES } from '../../../../vendor/pixel-agents/core/src/defaultCharacterProfiles.js';
import { parseWardrobeItems, type WardrobeItem } from '../../../../vendor/pixel-agents/core/src/wardrobeItems.js';
import { castStore } from '../../../../vendor/pixel-agents/webview-ui/src/characters/castStore.js';
import { CharactersView } from '../../../../vendor/pixel-agents/webview-ui/src/characters/ui/CharactersView.js';
import { MOBILE_MEDIA_QUERY } from '../../../../vendor/pixel-agents/webview-ui/src/constants.js';
import {
  DESIGNER_CHANNEL,
  type DesignerEvent,
  isDesignerCommand,
} from './designerProtocol';
import { transport } from './transport';

/** This browser's cast: the designer's stand-in for Pixel Agents' `~/.pixel-agents/characters.json`. */
const CAST_STORAGE_KEY = 'pixel-index.character-designer.cast';

function post(event: DesignerEvent): void {
  window.parent.postMessage(event, window.location.origin);
}

/** The cast this browser saved last, validated as upstream validates a save; the defaults when there is none. */
function storedCast(): { profiles: CharacterProfile[]; items: WardrobeItem[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(CAST_STORAGE_KEY) ?? 'null') as {
      profiles?: unknown;
      items?: unknown;
    } | null;
    const profiles = parseCharacterProfiles(raw?.profiles);
    if (profiles) return { profiles, items: parseWardrobeItems(raw?.items ?? []) ?? [] };
  } catch {
    // Unreadable or blocked storage: start from the defaults, like a fresh install.
  }
  return { profiles: [...DEFAULT_CHARACTER_PROFILES], items: [] };
}

/**
 * Upstream's Characters view saves the whole cast over the transport and
 * waits for the server's `characterProfilesLoaded` answering its saveId.
 * Here the browser is the server: the save is kept in localStorage and
 * answered at once with the list as saved.
 */
transport.setSendHandler((message) => {
  if (message.type !== 'saveCharacterProfiles') return;
  const profiles = parseCharacterProfiles(message.profiles);
  const items = parseWardrobeItems(message.items ?? []) ?? [];
  if (profiles) {
    try {
      localStorage.setItem(CAST_STORAGE_KEY, JSON.stringify({ profiles, items }));
    } catch {
      // Storage full or blocked: the cast still lives for this visit.
    }
  }
  queueMicrotask(() => castStore.receiveProfiles(profiles, message.saveId, items));
});

const initial = storedCast();
castStore.receiveProfiles(initial.profiles, undefined, initial.items);

/** The custom items (`custom_…` part ids) a profile wears. */
function customItemsOf(profile: CharacterProfile): string[] {
  const worn = profile as unknown as Record<string, unknown>;
  return CHARACTER_SLOTS.map((slot) => worn[slot]).filter(
    (id): id is string => typeof id === 'string' && id.startsWith('custom_'),
  );
}

function postSelection(): void {
  const { draft, profiles, current } = castStore.getState();
  // `.at`, typed `| undefined`: an empty cast has no profile at `current`.
  const profile = (draft ?? profiles).at(current);
  post({
    channel: DESIGNER_CHANNEL,
    type: 'selection',
    profile: profile ? { ...profile } : null,
    customItems: profile ? customItemsOf(profile) : [],
  });
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(MOBILE_MEDIA_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/**
 * Pixel Agents' own Characters view, unmodified, in `character-designer.html`
 * — the cast it edits is this browser's (`storedCast`), and the page outside
 * publishes the character on its stage (`designerProtocol.ts`).
 */
export function DesignerApp() {
  const phone = usePhone();

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (!isDesignerCommand(event.data)) return;
      // A copy: its own id, so publishing or editing it never touches the original's.
      const profile = { ...(event.data.profile as unknown as CharacterProfile), id: newCharacterId() };
      const parsed: CharacterProfile | undefined = parseCharacterProfiles([profile])?.[0];
      if (parsed && castStore.add([parsed], 0)) castStore.select(0);
    }
    window.addEventListener('message', onMessage);
    const unsubscribe = castStore.subscribe(postSelection);
    post({ channel: DESIGNER_CHANNEL, type: 'ready' });
    postSelection();
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribe();
    };
  }, []);

  return <CharactersView phone={phone} onClose={() => post({ channel: DESIGNER_CHANNEL, type: 'close' })} />;
}
