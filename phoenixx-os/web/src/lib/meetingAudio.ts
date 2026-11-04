/**
 * Prepares a meeting recording for upload, entirely in the browser.
 *
 * Two hard limits shape this: a serverless request carries at most ~4.5 MB,
 * and the speech-to-text API accepts at most 25 MB per file. So the browser
 * decodes the recording (audio or video - the audio track is what is kept),
 * downmixes it to 16 kHz mono, which is what speech recognition uses anyway,
 * and cuts it into ~10-minute WAV parts of ~19 MB each. Each part is then
 * uploaded in small chunks. Nothing leaves the machine until the user starts
 * the upload, and the original file never leaves it at all.
 */

export const SAMPLE_RATE = 16_000;
export const PART_SECONDS = 600;
export const CHUNK_BYTES = 3 * 1024 * 1024;

export type AudioPart = { index: number; offset_seconds: number; duration: number; blob: Blob };

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wav(samples: Float32Array): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const bytes = samples.length * 2;
  const text = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, bytes, true);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([header, pcm.buffer], { type: 'audio/wav' });
}

/** Decodes, downmixes and splits. Throws a readable error for files the browser cannot decode. */
export async function prepareRecording(file: File, onStage?: (s: string) => void): Promise<{
  parts: AudioPart[]; duration: number; hash: string;
}> {
  onStage?.('Reading the file…');
  const buf = await file.arrayBuffer();
  const hash = await sha256(buf);
  onStage?.('Extracting the audio…');
  const Ctx: typeof OfflineAudioContext = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot process recordings. Use Chrome, Edge or Safari, or upload a transcript.');
  let audio: AudioBuffer;
  try {
    // A context at 16 kHz makes decodeAudioData resample as it decodes.
    audio = await new Ctx(1, 1, SAMPLE_RATE).decodeAudioData(buf.slice(0));
  } catch {
    throw new Error('Could not read the audio in this file. Check it plays, or convert it to MP3 and try again.');
  }
  onStage?.('Splitting into parts…');
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  const per = PART_SECONDS * SAMPLE_RATE;
  const parts: AudioPart[] = [];
  for (let start = 0, index = 0; start < n; start += per, index++) {
    const slice = mono.subarray(start, Math.min(n, start + per));
    parts.push({ index, offset_seconds: start / SAMPLE_RATE, duration: slice.length / SAMPLE_RATE, blob: wav(slice) });
  }
  return { parts, duration: n / SAMPLE_RATE, hash };
}
