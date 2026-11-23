import { useSyncExternalStore } from 'react';

export interface NinjaCollectionTag {
  id: string;
  name: string;
  builtIn?: boolean;
}

export interface ExportedNinjaRecord {
  exportedAt: number;
  method: 'browser' | 'termux';
}

export interface NinjaCollectionsState {
  favorites: string[];
  tags: NinjaCollectionTag[];
  /** Map of ninjaId -> array of tag IDs */
  assignments: Record<string, string[]>;
  /** Map of ninjaId -> last export metadata */
  exported: Record<string, ExportedNinjaRecord>;
}

const STORAGE_KEY = 'shinobi_collections_v1';

const DEFAULT_TAGS: NinjaCollectionTag[] = [
  { id: 'para_jogo', name: 'Para o jogo', builtIn: true },
  { id: 'time_principal', name: 'Time principal', builtIn: true },
  { id: 'chefes', name: 'Chefes', builtIn: true },
];

function createDefaultState(): NinjaCollectionsState {
  return {
    favorites: [],
    tags: DEFAULT_TAGS.map((t) => ({ ...t })),
    assignments: {},
    exported: {},
  };
}

function loadState(): NinjaCollectionsState {
  if (typeof window === 'undefined') return createDefaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultState();
    const parsed = JSON.parse(raw) as Partial<NinjaCollectionsState>;
    const favorites = Array.isArray(parsed.favorites)
      ? Array.from(new Set(parsed.favorites.filter((x): x is string => typeof x === 'string' && x.length > 0)))
      : [];

    const existingTagIds = new Set<string>();
    const tags: NinjaCollectionTag[] = [];
    for (const dt of DEFAULT_TAGS) {
      tags.push({ ...dt });
      existingTagIds.add(dt.id);
    }
    if (Array.isArray(parsed.tags)) {
      for (const t of parsed.tags) {
        if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') continue;
        const cleanName = t.name.trim();
        if (!cleanName || existingTagIds.has(t.id)) continue;
        existingTagIds.add(t.id);
        tags.push({ id: t.id, name: cleanName, builtIn: Boolean(t.builtIn) });
      }
    }

    const assignments: Record<string, string[]> = {};
    if (parsed.assignments && typeof parsed.assignments === 'object') {
      for (const [nid, list] of Object.entries(parsed.assignments)) {
        if (!Array.isArray(list)) continue;
        const valid = Array.from(
          new Set(list.filter((tid): tid is string => typeof tid === 'string' && existingTagIds.has(tid)))
        );
        if (valid.length > 0) assignments[nid] = valid;
      }
    }

    const exported: Record<string, ExportedNinjaRecord> = {};
    if (parsed.exported && typeof parsed.exported === 'object') {
      for (const [nid, rec] of Object.entries(parsed.exported)) {
        if (!rec || typeof rec !== 'object') continue;
        const method = rec.method === 'termux' ? 'termux' : 'browser';
        const exportedAt = typeof rec.exportedAt === 'number' ? rec.exportedAt : Date.now();
        exported[nid] = { exportedAt, method };
      }
    }

    return { favorites, tags, assignments, exported };
  } catch {
    return createDefaultState();
  }
}

let state: NinjaCollectionsState = loadState();
const listeners = new Set<() => void>();

function saveState(next: NinjaCollectionsState) {
  state = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota errors
    }
  }
  for (const fn of listeners) {
    fn();
  }
}

export function subscribeNinjaCollections(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNinjaCollectionsSnapshot(): NinjaCollectionsState {
  return state;
}

export function useNinjaCollections(): NinjaCollectionsState {
  return useSyncExternalStore(
    subscribeNinjaCollections,
    getNinjaCollectionsSnapshot,
    getNinjaCollectionsSnapshot
  );
}

export function isNinjaFavorite(ninjaId: string): boolean {
  return state.favorites.includes(ninjaId);
}

export function toggleNinjaFavorite(ninjaId: string): boolean {
  const exists = state.favorites.includes(ninjaId);
  const favorites = exists
    ? state.favorites.filter((id) => id !== ninjaId)
    : [...state.favorites, ninjaId];
  saveState({ ...state, favorites });
  return !exists;
}

export function getNinjaTagIds(ninjaId: string): string[] {
  return state.assignments[ninjaId] || [];
}

export function toggleNinjaTag(ninjaId: string, tagId: string): boolean {
  const current = state.assignments[ninjaId] || [];
  const exists = current.includes(tagId);
  const nextList = exists ? current.filter((id) => id !== tagId) : [...current, tagId];
  const nextAssignments = { ...state.assignments };
  if (nextList.length > 0) {
    nextAssignments[ninjaId] = nextList;
  } else {
    delete nextAssignments[ninjaId];
  }
  saveState({ ...state, assignments: nextAssignments });
  return !exists;
}

export function setBulkNinjaTag(ninjaIds: string[], tagId: string, add = true): void {
  if (ninjaIds.length === 0) return;
  const nextAssignments = { ...state.assignments };
  for (const nid of ninjaIds) {
    const current = nextAssignments[nid] || [];
    if (add) {
      if (!current.includes(tagId)) {
        nextAssignments[nid] = [...current, tagId];
      }
    } else {
      const filtered = current.filter((id) => id !== tagId);
      if (filtered.length > 0) {
        nextAssignments[nid] = filtered;
      } else {
        delete nextAssignments[nid];
      }
    }
  }
  saveState({ ...state, assignments: nextAssignments });
}

export function createCustomTag(rawName: string): NinjaCollectionTag | null {
  const clean = rawName.trim().slice(0, 32);
  if (!clean) return null;
  const dup = state.tags.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (dup) return dup;
  const slug = clean
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const id = `tag_${slug || 'lista'}_${Date.now().toString(36).slice(-4)}`;
  const tag: NinjaCollectionTag = { id, name: clean, builtIn: false };
  saveState({ ...state, tags: [...state.tags, tag] });
  return tag;
}

export function deleteCustomTag(tagId: string): void {
  const target = state.tags.find((t) => t.id === tagId);
  if (!target || target.builtIn) return;
  const nextTags = state.tags.filter((t) => t.id !== tagId);
  const nextAssignments: Record<string, string[]> = {};
  for (const [nid, list] of Object.entries(state.assignments)) {
    const filtered = list.filter((id) => id !== tagId);
    if (filtered.length > 0) nextAssignments[nid] = filtered;
  }
  saveState({ ...state, tags: nextTags, assignments: nextAssignments });
}

export function markNinjaExported(ninjaId: string, method: 'browser' | 'termux'): void {
  saveState({
    ...state,
    exported: {
      ...state.exported,
      [ninjaId]: { exportedAt: Date.now(), method },
    },
  });
}

export function markManyNinjasExported(ninjaIds: string[], method: 'browser' | 'termux'): void {
  if (ninjaIds.length === 0) return;
  const now = Date.now();
  const nextExported = { ...state.exported };
  for (const id of ninjaIds) {
    nextExported[id] = { exportedAt: now, method };
  }
  saveState({ ...state, exported: nextExported });
}

export function toggleNinjaExportedManual(ninjaId: string): boolean {
  const nextExported = { ...state.exported };
  if (nextExported[ninjaId]) {
    delete nextExported[ninjaId];
    saveState({ ...state, exported: nextExported });
    return false;
  }
  nextExported[ninjaId] = { exportedAt: Date.now(), method: 'browser' };
  saveState({ ...state, exported: nextExported });
  return true;
}
