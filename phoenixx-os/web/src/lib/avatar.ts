import { useEffect, useReducer } from 'react';
import { avatarColor } from './format';
import { API_ORIGIN } from './config';

/** A stored profile photo's address, made absolute where the page is not served by the API (the phone app). */
export const photoUrl = (url?: string | null) => (url && url.startsWith('/api/') ? `${API_ORIGIN}${url}` : url || null);

/**
 * Stock photos for people who have not uploaded their own.
 *
 * The photos live in /public/avatars/stock/ and are listed in its
 * manifest.json ({ "photos": ["01.jpg", ...] }). Everyone without a photo of
 * their own gets one from that pool, picked from their name, so the same
 * person always gets the same photo. Use only photos you are licensed to use
 * this way - ideally AI-generated faces of people who do not exist.
 *
 * With an empty pool (or before the manifest has loaded) an avatar shows soft
 * initials instead.
 */
let pool: string[] | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

function load() {
  if (!loading) {
    loading = fetch('/avatars/stock/manifest.json', { cache: 'no-cache' }) // revalidate: new photos show without waiting for a cache to expire
      .then((r) => (r.ok ? r.json() : { photos: [] }))
      .then((m: any) => {
        pool = (Array.isArray(m?.photos) ? m.photos : [])
          .filter((p: unknown) => typeof p === 'string' && /^[\w.-]+\.(jpe?g|png|webp|avif)$/i.test(p as string))
          .map((p: string) => `/avatars/stock/${p}`);
      })
      .catch(() => { pool = []; })
      .finally(() => { waiting.forEach((wake) => wake()); waiting.clear(); });
  }
  return loading;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The stock photo for this name, or null (empty pool, or not loaded yet). */
export function stockPhoto(seed?: string | null): string | null {
  if (pool === null) { void load(); return null; }
  if (!pool.length || !seed) return null;
  return pool[hash(seed.trim().toLowerCase()) % pool.length];
}

/** stockPhoto for a component: re-renders it once the pool is known. */
export function useStockPhoto(seed?: string | null): string | null {
  const [, wake] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (pool !== null) return undefined;
    waiting.add(wake);
    void load();
    return () => { waiting.delete(wake); };
  }, []);
  return stockPhoto(seed);
}

/** A soft circle of the person's colour, behind a photo while it loads. */
export const avatarTint = (seed?: string | null) => `color-mix(in srgb, ${avatarColor(seed)} 18%, #ffffff)`;
