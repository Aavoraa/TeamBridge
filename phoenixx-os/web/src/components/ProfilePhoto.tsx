import { useRef, useState } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, Button, useToast } from './ui';

/** Longest side of the stored photo. Avatars are shown at most ~70px, so this stays sharp on any screen. */
const SIZE = 384;

/**
 * Crops the picked photo to a centred square and shrinks it to a small JPEG in
 * the browser, so a 6 MB phone photo uploads as ~40 KB.
 */
async function squareJpeg(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file could not be read as a picture.'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare the photo.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out, out);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Your own photo, with Change and Remove. Everyone in the workspace sees it beside your name. */
export function ProfilePhoto() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 'upload' | 'remove'>('');

  const pick = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Choose a photo (JPG, PNG or WebP).'); return; }
    setBusy('upload');
    try {
      const image = await squareJpeg(file);
      await api.post('/me/avatar', { image });
      await refresh();
      toast.success('Photo updated. Your team sees it beside your name.');
    } catch (e: any) {
      toast.error(e.message || 'The photo could not be saved.');
    } finally {
      setBusy('');
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await api.del('/me/avatar');
      await refresh();
      toast.success('Photo removed.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex items-center gap-4">
      <button type="button" onClick={() => input.current?.click()} disabled={!!busy}
        aria-label="Change your photo" title="Change your photo"
        className="group relative shrink-0 rounded-full cursor-pointer disabled:cursor-wait">
        <Avatar name={user?.name} url={user?.avatar_url} size={64} />
        <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
          <Camera size={18} />
        </span>
      </button>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-ink">{user?.name}</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button size="sm" icon={<Camera size={14} />} loading={busy === 'upload'} disabled={!!busy}
            onClick={() => input.current?.click()}>
            {user?.avatar_url ? 'Change photo' : 'Add a photo'}
          </Button>
          {user?.avatar_url && (
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} loading={busy === 'remove'} disabled={!!busy}
              onClick={remove}>Remove</Button>
          )}
        </div>
        <p className="mt-1.5 text-[12px] text-subtle">Shown to everyone in your workspace. JPG, PNG or WebP.</p>
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}
