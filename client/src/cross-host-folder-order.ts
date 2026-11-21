import { conversationFolderOrder, isFolderPinned, type ConversationFoldersState } from '../../src/client-protocol/conversation-folders.js';

export const CROSS_HOST_FOLDER_ORDER_KEY = 'open-super-agent-cross-host-folder-order-v1';

export type CrossHostFolderRef = {
  hostKey: string;
  /** Non-empty custom folder ID on the owning host, or null for its system Unfiled section. */
  folderId: string | null;
};

/** App-local cross-host folder display order. Stored only on this device; does
 * not alter any Hub's per-host folder order or sync contract. */
export type StoredCrossHostFolderOrder = {
  version: 1;
  pinned: string[];
  ordinary: string[];
};

export type CrossHostFolderSource = {
  hostId: string;
  hostKey: string;
  hostName: string;
  folders: ConversationFoldersState;
  online?: boolean;
  /** True only when this host supports folders and an authoritative folder snapshot has been received. */
  foldersAuthoritative?: boolean;
};

export type CrossHostFolderItem = {
  key: string;
  hostId: string;
  hostKey: string;
  hostName: string;
  folderId: string | null;
  /** Raw custom folder name; undefined for system Unfiled (localized at render time). */
  name?: string;
  pinned: boolean;
  hasCustomFolders: boolean;
};

export function folderHostIdentity(identity: { hubPublicKey?: string } | undefined, fallbackHostId = ''): string {
  return identity?.hubPublicKey || fallbackHostId;
}

export function crossHostFolderKey(ref: CrossHostFolderRef): string {
  return JSON.stringify([ref.hostKey, ref.folderId]);
}

export function parseCrossHostFolderKey(key: string): CrossHostFolderRef | undefined {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [hostKey, folderId] = value;
    if (typeof hostKey !== 'string' || !hostKey) return undefined;
    if (folderId !== null && (typeof folderId !== 'string' || !folderId)) return undefined;
    return { hostKey, folderId };
  } catch {
    return undefined;
  }
}

export const emptyCrossHostFolderOrder = (): StoredCrossHostFolderOrder => ({
  version: 1,
  pinned: [],
  ordinary: [],
});

function uniqueValidKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>(), out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || seen.has(item) || !parseCrossHostFolderKey(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseStoredCrossHostFolderOrder(raw: unknown): StoredCrossHostFolderOrder {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCrossHostFolderOrder();
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return emptyCrossHostFolderOrder();
  return {
    version: 1,
    pinned: uniqueValidKeys(value.pinned),
    ordinary: uniqueValidKeys(value.ordinary),
  };
}

function collectLiveTiers(sources: readonly CrossHostFolderSource[]) {
  const pinned: CrossHostFolderItem[] = [];
  const ordinary: CrossHostFolderItem[] = [];
  const canonicalPinnedByHost = new Map<string, string[]>();
  const canonicalOrdinaryByHost = new Map<string, string[]>();
  const seenHosts = new Set<string>();
  const seenKeys = new Set<string>();

  for (const source of sources) {
    if (!source.hostKey || seenHosts.has(source.hostKey)) continue;
    seenHosts.add(source.hostKey);
    const names = new Map(source.folders.folders.map(folder => [folder.id, folder.name]));
    const hasCustomFolders = source.folders.folders.length > 0;
    const hostPinned: string[] = [];
    const hostOrdinary: string[] = [];
    for (const folderId of conversationFolderOrder(source.folders)) {
      if (folderId !== null && !names.has(folderId)) continue;
      const key = crossHostFolderKey({ hostKey: source.hostKey, folderId });
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const isPinned = isFolderPinned(source.folders, folderId);
      const item: CrossHostFolderItem = {
        key,
        hostId: source.hostId,
        hostKey: source.hostKey,
        hostName: source.hostName,
        folderId,
        name: folderId === null ? undefined : names.get(folderId),
        pinned: isPinned,
        hasCustomFolders,
      };
      if (isPinned) {
        pinned.push(item);
        hostPinned.push(key);
      } else {
        ordinary.push(item);
        hostOrdinary.push(key);
      }
    }
    canonicalPinnedByHost.set(source.hostKey, hostPinned);
    canonicalOrdinaryByHost.set(source.hostKey, hostOrdinary);
  }
  return { pinned, ordinary, canonicalPinnedByHost, canonicalOrdinaryByHost };
}

function resolveTier(
  liveItems: readonly CrossHostFolderItem[],
  savedKeys: readonly string[],
  canonicalByHost: ReadonlyMap<string, readonly string[]>,
): CrossHostFolderItem[] {
  const liveByKey = new Map(liveItems.map(item => [item.key, item]));
  const result: string[] = [];
  const placed = new Set<string>();

  for (const key of savedKeys) {
    if (!liveByKey.has(key) || placed.has(key)) continue;
    result.push(key);
    placed.add(key);
  }

  for (const item of liveItems) {
    if (placed.has(item.key)) continue;
    const hostOrder = canonicalByHost.get(item.hostKey) ?? [];
    const index = hostOrder.indexOf(item.key);
    let inserted = false;
    for (let i = index - 1; i >= 0; i--) {
      const prev = hostOrder[i]!;
      if (placed.has(prev)) {
        result.splice(result.indexOf(prev) + 1, 0, item.key);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      for (let i = index + 1; i < hostOrder.length; i++) {
        const next = hostOrder[i]!;
        if (placed.has(next)) {
          result.splice(result.indexOf(next), 0, item.key);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) result.push(item.key);
    placed.add(item.key);
  }

  return result.map(key => liveByKey.get(key)!);
}

/** Merge live per-host folder snapshots with the App-local cross-host order.
 * Pinned folders across all hosts stay first; newly created folders land beside
 * their host's canonical neighbors; offline or hidden hosts are never dropped. */
export function resolveCrossHostFolderOrder(
  sources: readonly CrossHostFolderSource[],
  stored: StoredCrossHostFolderOrder,
): CrossHostFolderItem[] {
  const { pinned, ordinary, canonicalPinnedByHost, canonicalOrdinaryByHost } = collectLiveTiers(sources);
  return [
    ...resolveTier(pinned, stored.pinned, canonicalPinnedByHost),
    ...resolveTier(ordinary, stored.ordinary, canonicalOrdinaryByHost),
  ];
}

function insertMissingByReference(base: string[], reference: readonly string[]): string[] {
  const out = [...base];
  const present = new Set(out);
  for (let i = 0; i < reference.length; i++) {
    const key = reference[i]!;
    if (present.has(key)) continue;
    let inserted = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = reference[j]!;
      if (present.has(prev)) {
        out.splice(out.indexOf(prev) + 1, 0, key);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      for (let j = i + 1; j < reference.length; j++) {
        const next = reference[j]!;
        if (present.has(next)) {
          out.splice(out.indexOf(next), 0, key);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) out.push(key);
    present.add(key);
  }
  return out;
}

function makeOnlineDeletionFilter(sources: readonly CrossHostFolderSource[]): (key: string) => boolean {
  const onlineFolders = new Map<string, ReadonlySet<string>>();
  for (const source of sources) {
    if (source.online !== true || source.foldersAuthoritative !== true || !source.hostKey) continue;
    onlineFolders.set(source.hostKey, new Set(source.folders.folders.map(folder => folder.id)));
  }
  return (key: string) => {
    const ref = parseCrossHostFolderKey(key);
    if (!ref || ref.folderId === null) return false;
    const known = onlineFolders.get(ref.hostKey);
    // Only prune custom folders confirmed absent on an online host whose
    // folder snapshot is authoritatively loaded and supported. Offline,
    // filtered, connecting, legacy, or uncached hosts keep every saved entry.
    return known !== undefined && !known.has(ref.folderId);
  };
}

function mergeTierOrder(
  prevSaved: readonly string[],
  resolvedFullTier: readonly string[],
  nextSubsetOrder: readonly string[],
  isConfirmedDeleted: (key: string) => boolean,
): string[] {
  const cleaned = uniqueValidKeys(prevSaved).filter(key => !isConfirmedDeleted(key));
  const subset = uniqueValidKeys(nextSubsetOrder);
  const subsetSet = new Set(subset);
  // Anchor every key in resolvedFullTier (including hidden-by-filter or
  // previously unrecorded items) before permuting only the edited subset slots.
  const baseline = insertMissingByReference(cleaned, resolvedFullTier);
  const withSubset = insertMissingByReference(baseline, subset);
  let cursor = 0;
  return withSubset.map(key => subsetSet.has(key) ? subset[cursor++]! : key);
}

/** Commit a reordered subset (or full list) of live cross-host folder keys.
 * Entries from offline, hidden, or filtered hosts and pinned folders' saved
 * ordinary restoration slots stay anchored in place. */
export function commitCrossHostFolderOrder(
  stored: StoredCrossHostFolderOrder,
  sources: readonly CrossHostFolderSource[],
  nextOrderKeys: readonly string[],
  editedKeys?: readonly string[],
): StoredCrossHostFolderOrder {
  const resolved = resolveCrossHostFolderOrder(sources, stored);
  const resolvedPinned = resolved.filter(item => item.pinned).map(item => item.key);
  const resolvedOrdinary = resolved.filter(item => !item.pinned).map(item => item.key);
  const pinnedSet = new Set(resolvedPinned);
  const ordinarySet = new Set(resolvedOrdinary);
  const editedSet = editedKeys ? new Set(editedKeys) : undefined;

  const dedupNext = uniqueValidKeys(nextOrderKeys);
  const nextPinned = dedupNext.filter(key => pinnedSet.has(key) && (!editedSet || editedSet.has(key)));
  for (const key of resolvedPinned) {
    if ((!editedSet || editedSet.has(key)) && !nextPinned.includes(key)) nextPinned.push(key);
  }
  const nextOrdinary = dedupNext.filter(key => ordinarySet.has(key) && (!editedSet || editedSet.has(key)));
  for (const key of resolvedOrdinary) {
    if ((!editedSet || editedSet.has(key)) && !nextOrdinary.includes(key)) nextOrdinary.push(key);
  }

  const isDeleted = makeOnlineDeletionFilter(sources);
  return {
    version: 1,
    pinned: nextPinned.length
      ? mergeTierOrder(stored.pinned, resolvedPinned, nextPinned, isDeleted)
      : uniqueValidKeys(stored.pinned).filter(key => !isDeleted(key)),
    ordinary: nextOrdinary.length
      ? mergeTierOrder(stored.ordinary, resolvedOrdinary, nextOrdinary, isDeleted)
      : uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key)),
  };
}

/** Move one folder up, down, or to the top within its own tier (pinned vs ordinary).
 * When `visibleKeys` is supplied (e.g. under search/filter), moves relative to
 * visible peers while keeping hidden folders anchored in their saved slots. */
export function moveCrossHostFolderOrder(
  stored: StoredCrossHostFolderOrder,
  sources: readonly CrossHostFolderSource[],
  targetKey: string,
  destination: 'up' | 'down' | 'top',
  visibleKeys?: readonly string[],
): StoredCrossHostFolderOrder {
  const resolved = resolveCrossHostFolderOrder(sources, stored);
  const visibleSet = visibleKeys ? new Set(visibleKeys) : undefined;
  const active = visibleSet ? resolved.filter(item => visibleSet.has(item.key)) : resolved;
  const index = active.findIndex(item => item.key === targetKey);
  if (index < 0) return stored;
  const item = active[index]!;
  const peers = active.filter(entry => entry.pinned === item.pinned);
  const first = active.indexOf(peers[0]!);
  const last = active.indexOf(peers.at(-1)!);
  const target = destination === 'top' ? first : destination === 'up' ? index - 1 : index + 1;
  if (target < first || target > last || target === index) return stored;
  const nextKeys = active.map(entry => entry.key);
  nextKeys.splice(target, 0, ...nextKeys.splice(index, 1));
  return commitCrossHostFolderOrder(stored, sources, nextKeys, active.map(entry => entry.key));
}

/** Update App-local pinned/ordinary placement after a Hub confirms a folder pin
 * or unpin. Pinning remembers the folder's current cross-host ordinary slot so
 * unpinning restores it while keeping any other ordinary reorders intact. */
export function recordCrossHostFolderPin(
  stored: StoredCrossHostFolderOrder,
  sourcesBeforePin: readonly CrossHostFolderSource[],
  targetKey: string,
  pinned: boolean,
): StoredCrossHostFolderOrder {
  if (!parseCrossHostFolderKey(targetKey)) return stored;
  const isDeleted = makeOnlineDeletionFilter(sourcesBeforePin);
  if (pinned) {
    const resolvedBefore = resolveCrossHostFolderOrder(sourcesBeforePin, stored);
    const resolvedOrdinaryBefore = resolvedBefore.filter(item => !item.pinned).map(item => item.key);
    const ordinary = resolvedOrdinaryBefore.includes(targetKey)
      ? mergeTierOrder(stored.ordinary, resolvedOrdinaryBefore, resolvedOrdinaryBefore, isDeleted)
      : uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key));
    const nextPinned = [targetKey, ...uniqueValidKeys(stored.pinned).filter(key => key !== targetKey && !isDeleted(key))];
    return { version: 1, pinned: nextPinned, ordinary };
  }
  return {
    version: 1,
    pinned: uniqueValidKeys(stored.pinned).filter(key => key !== targetKey && !isDeleted(key)),
    ordinary: uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key)),
  };
}

/** Remove all saved entries belonging to a permanently removed host. */
export function pruneCrossHostFolderOrderHost(
  stored: StoredCrossHostFolderOrder,
  hostKey: string,
): StoredCrossHostFolderOrder {
  if (!hostKey) return stored;
  const keep = (key: string) => parseCrossHostFolderKey(key)?.hostKey !== hostKey;
  const pinned = stored.pinned.filter(keep);
  const ordinary = stored.ordinary.filter(keep);
  if (pinned.length === stored.pinned.length && ordinary.length === stored.ordinary.length) return stored;
  return { version: 1, pinned, ordinary };
}

/** Filter resolved cross-host folder items down to the ones that should render
 * in the sidebar or mobile inbox, matching existing single-host rules:
 * - Hosts with custom folders show every folder when unfiltered, and only
 *   non-empty folders when filtered.
 * - Folder-free hosts only show their synthetic Unfiled section while they
 *   have at least one matching ordinary conversation row. */
export function visibleCrossHostFolders(
  items: readonly CrossHostFolderItem[],
  rowCountFor: (hostId: string, folderId: string | null) => number,
  filtered: boolean,
): CrossHostFolderItem[] {
  return items.filter(item => {
    const count = rowCountFor(item.hostId, item.folderId);
    if (!item.hasCustomFolders) return count > 0;
    return !filtered || count > 0;
  });
}

// --- App-local storage store (localStorage + in-memory fallback + cross-window sync) ---

let cachedOrder: StoredCrossHostFolderOrder | undefined;
const listeners = new Set<() => void>();
let storageListenerAttached = false;

function readFromStorage(): StoredCrossHostFolderOrder {
  if (typeof localStorage === 'undefined') return emptyCrossHostFolderOrder();
  try {
    const raw = localStorage.getItem(CROSS_HOST_FOLDER_ORDER_KEY);
    if (!raw) return emptyCrossHostFolderOrder();
    return parseStoredCrossHostFolderOrder(JSON.parse(raw));
  } catch {
    return emptyCrossHostFolderOrder();
  }
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== CROSS_HOST_FOLDER_ORDER_KEY) return;
  cachedOrder = readFromStorage();
  for (const listener of listeners) listener();
}

function listenForStorageChanges(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  window.addEventListener('storage', handleStorageEvent);
  storageListenerAttached = true;
}

export function readCrossHostFolderOrder(): StoredCrossHostFolderOrder {
  listenForStorageChanges();
  if (cachedOrder) return cachedOrder;
  cachedOrder = readFromStorage();
  return cachedOrder;
}

export function writeCrossHostFolderOrder(next: StoredCrossHostFolderOrder): void {
  listenForStorageChanges();
  const sanitized = parseStoredCrossHostFolderOrder(next);
  cachedOrder = sanitized;
  if (typeof localStorage !== 'undefined') {
    try {
      if (!sanitized.pinned.length && !sanitized.ordinary.length) {
        localStorage.removeItem(CROSS_HOST_FOLDER_ORDER_KEY);
      } else {
        localStorage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify(sanitized));
      }
    } catch {
      /* Memory still keeps this session's choice. */
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeCrossHostFolderOrder(listener: () => void): () => void {
  listeners.add(listener);
  listenForStorageChanges();
  // The cached store outlives its views, including host removal without a view.
  // Keep one document-lifetime listener so hidden views cannot miss remote
  // changes; reloading storage on remount would discard failed-write fallback.
  return () => { listeners.delete(listener); };
}

export function removeCrossHostFolderOrderHost(hostKey: string): void {
  const current = readCrossHostFolderOrder();
  const next = pruneCrossHostFolderOrderHost(current, hostKey);
  if (next !== current) writeCrossHostFolderOrder(next);
}

export function saveCrossHostFolderOrder(
  sources: readonly CrossHostFolderSource[],
  nextOrderKeys: readonly string[],
  editedKeys?: readonly string[],
): void {
  writeCrossHostFolderOrder(commitCrossHostFolderOrder(readCrossHostFolderOrder(), sources, nextOrderKeys, editedKeys));
}

export function applyCrossHostFolderMove(
  sources: readonly CrossHostFolderSource[],
  targetKey: string,
  destination: 'up' | 'down' | 'top',
  visibleKeys?: readonly string[],
): void {
  const current = readCrossHostFolderOrder();
  const next = moveCrossHostFolderOrder(current, sources, targetKey, destination, visibleKeys);
  if (next !== current) writeCrossHostFolderOrder(next);
}

export function applyCrossHostFolderPin(
  sourcesBeforePin: readonly CrossHostFolderSource[],
  targetKey: string,
  pinned: boolean,
): void {
  writeCrossHostFolderOrder(recordCrossHostFolderPin(readCrossHostFolderOrder(), sourcesBeforePin, targetKey, pinned));
}

export function resetCrossHostFolderOrderCache(): void {
  cachedOrder = undefined;
  if (storageListenerAttached && typeof window !== 'undefined') {
    window.removeEventListener('storage', handleStorageEvent);
    storageListenerAttached = false;
  }
}
