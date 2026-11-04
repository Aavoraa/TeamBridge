/**
 * Just enough Ogg to cut an Ogg Opus file (what LiveKit track egress writes)
 * into time windows without decoding it, so a long recording can be sent to
 * speech-to-text in pieces that fit its size and length limits.
 *
 * Each piece is a valid file: the original header pages (OpusHead, OpusTags),
 * then the audio pages whose end falls in the window. Granule positions are
 * rebased so the piece starts at zero, page numbers are renumbered, the last
 * page is marked end-of-stream, and every checksum is recomputed.
 */

const SAMPLE_RATE = 48_000; // Opus granule positions always count 48 kHz samples
const NO_GRANULE = -1n;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Splits a buffer into Ogg pages. Throws on anything that is not Ogg. */
export function readPages(buf) {
  const pages = [];
  let at = 0;
  while (at < buf.length) {
    if (buf.length - at < 27 || buf.toString('latin1', at, at + 4) !== 'OggS') {
      if (!pages.length) throw new Error('Not an Ogg file');
      break; // a truncated tail (egress stopped mid-write) is dropped
    }
    const segments = buf[at + 26];
    const headerLen = 27 + segments;
    if (at + headerLen > buf.length) break;
    let bodyLen = 0;
    for (let i = 0; i < segments; i++) bodyLen += buf[at + 27 + i];
    if (at + headerLen + bodyLen > buf.length) break;
    pages.push({
      flags: buf[at + 5],
      granule: buf.readBigInt64LE(at + 6),
      bytes: buf.subarray(at, at + headerLen + bodyLen),
    });
    at += headerLen + bodyLen;
  }
  return pages;
}

function writePage(page, { seq, granule, flags }) {
  const out = Buffer.from(page.bytes); // copy: the source stays untouched
  out[5] = flags;
  out.writeBigInt64LE(granule, 6);
  out.writeUInt32LE(seq, 18);
  out.writeUInt32LE(0, 22);
  out.writeUInt32LE(crc32(out), 22);
  return out;
}

const isHeader = (p, i) => i === 0 || p.granule === 0n;

/** Length of the audio in seconds, from the last granule position. */
export function oggDurationSeconds(buf) {
  const pages = readPages(buf);
  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i].granule > 0n) return Number(pages[i].granule) / SAMPLE_RATE;
  }
  return 0;
}

/**
 * The audio between startSec and endSec as its own Ogg Opus file, or null if
 * there is no audio in that window.
 */
export function sliceOgg(buf, startSec, endSec) {
  const pages = readPages(buf);
  const headers = [];
  let i = 0;
  while (i < pages.length && isHeader(pages[i], i)) headers.push(pages[i++]);
  if (!headers.length) throw new Error('Ogg file has no header');

  const from = BigInt(Math.round(startSec * SAMPLE_RATE));
  const to = BigInt(Math.round(endSec * SAMPLE_RATE));
  const audio = [];
  let last = 0n;
  for (; i < pages.length; i++) {
    const p = pages[i];
    // A page with no granule (one packet spanning pages) sits where the previous page ended.
    const pos = p.granule === NO_GRANULE ? last : p.granule;
    if (p.granule !== NO_GRANULE) last = p.granule;
    if (pos > from && pos <= to) audio.push(p);
    else if (pos > to) break;
  }
  if (!audio.length) return null;

  const out = [];
  let seq = 0;
  for (const h of headers) out.push(writePage(h, { seq: seq++, granule: h.granule, flags: h.flags & ~0x04 }));
  audio.forEach((p, n) => {
    let flags = p.flags & ~0x06; // no BOS in the middle, EOS only at the end
    if (n === audio.length - 1) flags |= 0x04;
    const granule = p.granule === NO_GRANULE ? NO_GRANULE : p.granule - from;
    out.push(writePage(p, { seq: seq++, granule, flags }));
  });
  return Buffer.concat(out);
}

export { crc32 as oggCrc32, SAMPLE_RATE as OPUS_RATE };
