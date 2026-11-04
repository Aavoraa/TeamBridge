/**
 * Downloads and PDF previews on a device.
 *
 * The web app turns a response into a `blob:` URL and either clicks a hidden
 * `<a download>` or calls `window.open`. Neither works in a WebView: a
 * WebView has no download manager, and `blob:` URLs are not addressable by the
 * OS, so both silently do nothing. Instead the bytes are written to the app's
 * sandboxed cache and handed to the system share sheet, which is what gives the
 * user "Save to Files", "Open in Adobe", "Send on WhatsApp" and so on.
 *
 * `saveAndOpen` returns false on the web so the caller keeps its existing
 * browser path — the two code paths live side by side rather than replacing
 * each other.
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** `data:<mime>;base64,<payload>` → just the payload, which is what Filesystem wants. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

/** Filenames reach the filesystem verbatim, so strip anything a path could use. */
function safeName(name: string): string {
  return name.replace(/[/\?%*:|"<>]/g, '-').slice(0, 120) || 'download';
}

export async function saveAndOpen(blob: Blob, filename: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  const path = safeName(filename);
  await Filesystem.writeFile({
    path,
    data: await toBase64(blob),
    directory: Directory.Cache,
  });

  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: filename, url: uri, dialogTitle: filename });
  return true;
}
