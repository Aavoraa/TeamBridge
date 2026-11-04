import net from 'node:net';
import { get, all } from '../db/index.js';

/**
 * Is this check-in coming from the office?
 *
 * The only network fact the server can establish for itself is the public
 * address a request arrives from (`req.ip`, resolved behind the hosting proxy
 * by Express's `trust proxy`). That is what is matched here, against the
 * connections HR has listed. Nothing the browser sends takes part: a Wi-Fi
 * name, an IP or a "verified" flag in the body would be the employee vouching
 * for themselves, and no browser can read the Wi-Fi name in the first place.
 *
 * The Wi-Fi names on each row are labels, so HR can tell which connection is
 * which. Every SSID served by one router shares that router's public address.
 */

export const METHOD = 'public_ip';

/** '::ffff:49.206.113.67' is how an IPv4 client can appear on a dual-stack socket. */
export function normaliseIp(raw) {
  if (!raw) return null;
  const ip = String(raw).trim().replace(/^::ffff:/i, '');
  return net.isIP(ip) ? ip : null;
}

/** Parses '49.206.113.67' or '117.98.188.0/24' (or IPv6) into a matchable range. */
export function parseRange(value) {
  const text = String(value || '').trim();
  const [addr, bits] = text.split('/');
  const family = net.isIP(addr);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
    return null;
  }
  return { addr, prefix, type: family === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * Address space the server can never see a client arrive from - LAN, loopback,
 * carrier NAT, link-local. Listing one would approve every employee's home
 * router, so the API refuses them with an explanation instead.
 */
const PRIVATE = new net.BlockList();
for (const [a, p] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8],
  ['100.64.0.0', 10], ['169.254.0.0', 16], ['0.0.0.0', 8]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['fc00::', 7], ['fe80::', 10], ['::1', 128], ['::', 128]]) PRIVATE.addSubnet(a, p, 'ipv6');

export const isPrivateRange = (range) => PRIVATE.check(range.addr, range.type);

/** A range too broad to mean "our office" - a /8 covers sixteen million addresses. */
export const isTooBroad = (range) => (range.type === 'ipv4' ? range.prefix < 16 : range.prefix < 48);

/**
 * The visitor's public address.
 *
 * On Render a request passes Cloudflare, then Render's own load balancer, so
 * `req.ip` (with `trust proxy` = 1) lands on an internal 10.x hop, not the
 * visitor. Cloudflare writes the real address into CF-Connecting-IP and
 * overwrites any value a client sends, so that header is authoritative - but
 * only when the request reached us through that internal hop. A request whose
 * nearest address is already public did not come through the platform proxy,
 * and a header on it is just something the sender typed, so it is ignored.
 */
const IP_HEADER = (process.env.CLIENT_IP_HEADER || 'cf-connecting-ip').toLowerCase();

export function requestIp(req) {
  const nearest = normaliseIp(req.ip);
  const nearestRange = nearest && parseRange(nearest);
  const viaInternalProxy = !nearest || (nearestRange && isPrivateRange(nearestRange));
  if (viaInternalProxy) {
    const fromEdge = normaliseIp(String(req.get?.(IP_HEADER) || '').split(',')[0]);
    if (fromEdge) return fromEdge;
  }
  return nearest;
}

/** What each source said, for HR's Test panel when the setup needs debugging. */
export const ipDiagnostics = (req) => ({
  proxy_ip: normaliseIp(req.ip),
  edge_header: IP_HEADER,
  edge_ip: normaliseIp(String(req.get?.(IP_HEADER) || '').split(',')[0]),
  forwarded_for: req.get?.('x-forwarded-for') || null,
});

export const checkEnabled =async (tenantId) => !!(await get('SELECT network_check FROM tenants WHERE id = ?', [tenantId]))?.network_check;

export const activeNetworks = async (tenantId) => await all(
  `SELECT * FROM approved_networks
    WHERE tenant_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY network_name, ssid`,
  [tenantId],
);

/** The first active network whose range holds this address, or null. */
export async function matchNetwork(tenantId, rawIp) {
  const ip = normaliseIp(rawIp);
  if (!ip) return null;
  const type = net.isIP(ip) === 4 ? 'ipv4' : 'ipv6';
  for (const n of await activeNetworks(tenantId)) {
    const range = parseRange(n.public_ip);
    if (!range || range.type !== type) continue;
    const list = new net.BlockList();
    list.addSubnet(range.addr, range.prefix, range.type);
    if (list.check(ip, type)) return n;
  }
  return null;
}

/**
 * The verdict for one check-in.
 *
 * Checked and recorded whenever the workspace has a network listed, switched
 * on or not: with the switch off it is a trial run, so HR can see who would
 * have matched before anybody's day depends on it. `enabled` is what decides
 * whether a miss sends the day to HR. `verified` is null only when there is
 * nothing to check against - "not checked" is a different fact from "failed".
 */
export async function verifyCheckIn(tenantId, rawIp) {
  const ip = normaliseIp(rawIp);
  const enabled = await checkEnabled(tenantId);
  if (!enabled && !(await activeNetworks(tenantId)).length) {
    return { enabled: false, verified: null, method: null, network: null, ip };
  }
  const network = await matchNetwork(tenantId, ip);
  return { enabled, verified: !!network, method: METHOD, network, ip };
}
