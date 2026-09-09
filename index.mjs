/**
 * BillStock Pro — WhatsApp link-device bridge
 *
 * Holds one WhatsApp Web companion session per shop, uploads the pairing QR,
 * and reports incoming contacts (phone, name, ad-click reference) to the app.
 * Message text is never stored or forwarded.
 */
import 'dotenv/config';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  BufferJSON,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 5000);

if (!BRIDGE_URL || !BRIDGE_TOKEN) {
  console.error('BRIDGE_URL and BRIDGE_TOKEN are required (see .env.example)');
  process.exit(1);
}

const logger = pino({ level: 'warn' });

/** userId -> { sock, saveTimer, closing } */
const sessions = new Map();

async function api(action, payload = {}) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': BRIDGE_TOKEN },
    body: JSON.stringify({ action, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.success) console.warn(`[bridge] ${action} failed:`, out.error || res.status);
  return out;
}

/** Auth state kept in the app database so the worker can be redeployed freely. */
function makeRemoteAuthState(userId, stored) {
  const parsed = stored ? JSON.parse(JSON.stringify(stored), BufferJSON.reviver) : null;
  const state = {
    creds: parsed?.creds || initAuthCreds(),
    keys: parsed?.keys || {},
  };

  const persist = async () => {
    await api('save_creds', {
      user_id: userId,
      creds: JSON.parse(JSON.stringify({ creds: state.creds, keys: state.keys }, BufferJSON.replacer)),
    });
  };

  const keyStore = {
    get: async (type, ids) => {
      const bucket = state.keys[type] || {};
      const out = {};
      for (const id of ids) {
        let value = bucket[id];
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        if (value) out[id] = value;
      }
      return out;
    },
    set: async (data) => {
      for (const type of Object.keys(data)) {
        state.keys[type] = state.keys[type] || {};
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          if (value === null) delete state.keys[type][id];
          else state.keys[type][id] = value;
        }
      }
      await persist();
    },
  };

  return { state: { creds: state.creds, keys: makeCacheableSignalKeyStore(keyStore, logger) }, persist };
}

function extractReferral(msg) {
  const ctx =
    msg?.message?.extendedTextMessage?.contextInfo ||
    msg?.message?.imageMessage?.contextInfo ||
    msg?.message?.videoMessage?.contextInfo ||
    msg?.message?.contextInfo;
  const ad = ctx?.externalAdReply;
  return {
    ctwa_clid: ctx?.conversionSource || ad?.ctwaClid || null,
    ad_id: ad?.sourceId || null,
    source_type: ad?.sourceType || (ad ? 'ad' : null),
  };
}

/**
 * Newer WhatsApp Business accounts often address inbound chats with a private
 * LID JID and expose the real phone JID in senderPn/remoteJidAlt/participantAlt.
 * Older accounts use @s.whatsapp.net directly. Keep a stable chat key (the LID
 * when that is all we get) but always try hard to resolve the real phone, since
 * order matching and Meta CAPI depend on it.
 */
function extractSender(msg) {
  const key = msg?.key || {};
  const candidates = [
    key.senderPn,
    key.remoteJidAlt,
    key.participantAlt,
    msg?.senderPn,
    key.remoteJid,
    key.participant,
  ].filter(Boolean);
  const digits = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  const phoneJid = candidates.find((jid) => String(jid).endsWith('@s.whatsapp.net'));
  const lidJid = candidates.find((jid) => String(jid).endsWith('@lid'));
  const selected = phoneJid || lidJid;
  if (!selected) return null;
  const waId = digits(selected);
  if (!waId) return null;
  return {
    waId,
    isLid: !phoneJid,
    phone: phoneJid ? digits(phoneJid) : null,
    lid: lidJid || null,
  };
}

/**
 * LID -> phone cache filled from contact events. WhatsApp Business often only
 * reveals the real number in a contacts.upsert/update payload, not on the
 * message itself, so remember every pair we ever see.
 */
const lidPhoneCache = new Map();

function rememberLidPhone(lid, phone) {
  const l = String(lid || '').split('@')[0].replace(/\D/g, '');
  const p = String(phone || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (l && p.length >= 10) lidPhoneCache.set(l, p);
}

function harvestContacts(contacts) {
  for (const c of contacts || []) {
    const id = String(c?.id || '');
    const alt = String(c?.jid || c?.lid || c?.phoneNumber || c?.pn || '');
    if (id.endsWith('@lid') && alt) rememberLidPhone(id, alt);
    if (id.endsWith('@s.whatsapp.net') && alt.endsWith('@lid')) rememberLidPhone(alt, id);
  }
}

/** Ask Baileys' LID mapping store for the phone number behind a @lid JID. */
async function resolvePhoneFromLid(sock, lidJid) {
  if (!lidJid) return null;
  const bare = String(lidJid).split('@')[0].replace(/\D/g, '');
  if (lidPhoneCache.has(bare)) return lidPhoneCache.get(bare);

  const mapping = sock?.signalRepository?.lidMapping;
  const tryFns = [
    () => mapping?.getPNForLID?.(lidJid),
    () => mapping?.getPNForLid?.(lidJid),
    () => mapping?.getPNForLID?.(bare),
    async () => {
      const keys = sock?.authState?.keys;
      const got = await keys?.get?.('lid-mapping', [bare, lidJid]);
      return got?.[bare] || got?.[lidJid] || null;
    },
    async () => {
      const res = await sock?.onWhatsApp?.(lidJid);
      return res?.[0]?.jid || null;
    },
  ];
  for (const fn of tryFns) {
    try {
      const pn = await fn();
      const digits = String(pn || '').split('@')[0].split(':')[0].replace(/\D/g, '');
      if (digits.length >= 10) {
        rememberLidPhone(bare, digits);
        return digits;
      }
    } catch { /* try next */ }
  }
  return null;
}



async function startSession(userId, storedCreds) {
  if (sessions.has(userId)) return;
  sessions.set(userId, { starting: true });

  const { state, persist } = makeRemoteAuthState(userId, storedCreds);

  // WhatsApp rejects stale web-client versions with an immediate socket close
  // and never emits a QR. Resolve the current supported version at session
  // start instead of relying on the version bundled with Baileys.
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[bridge] WhatsApp Web version ${version.join('.')} (latest: ${isLatest})`);
  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
    // WhatsApp Business rejects custom/unknown client identities during
    // link-device pairing (the scan appears to succeed, then the socket closes
    // without ever reaching 'open'). A standard desktop browser identity is
    // accepted by both WhatsApp and WhatsApp Business.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Business accounts sync a large app-state payload right after pairing;
    // a short timeout closes the socket mid-handshake and pairing never lands.
    defaultQueryTimeoutMs: 120_000,
    keepAliveIntervalMs: 20_000,
    connectTimeoutMs: 60_000,
    retryRequestDelayMs: 1_000,
  });

  sessions.set(userId, { sock });

  sock.ev.on('creds.update', () => { persist().catch(() => {}); });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        console.log(`[bridge] QR received for ${userId}; uploading`);
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        const result = await api('set_qr', { user_id: userId, qr: dataUrl });
        if (result.success) console.log(`[bridge] QR uploaded for ${userId}`);
      } catch (e) {
        console.warn('[bridge] qr encode failed:', e.message);
      }
    }

    if (connection === 'open') {
      const jid = sock.user?.id || '';
      await api('set_status', {
        user_id: userId,
        status: 'connected',
        phone_number: jid.split(':')[0].split('@')[0],
        display_name: sock.user?.name || null,
      });
      console.log(`[bridge] ${userId} connected`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sessions.delete(userId);
      await api('set_status', {
        user_id: userId,
        status: 'disconnected',
        clear_creds: loggedOut,
        error: loggedOut ? 'Device unlinked from WhatsApp' : `WhatsApp socket closed (${code || 'unknown'}); retrying`,
      });
      console.log(`[bridge] ${userId} closed (code ${code || 'n/a'})`);
    }
  });

  // Contact events are the most reliable place WhatsApp Business reveals the
  // real phone number behind a LID chat. Cache every pair, and immediately
  // patch chats we had already stored without a phone.
  const onContacts = async (contacts) => {
    harvestContacts(contacts);
    for (const c of contacts || []) {
      const id = String(c?.id || '');
      if (!id.endsWith('@lid')) continue;
      const bare = id.split('@')[0].replace(/\D/g, '');
      const phone = lidPhoneCache.get(bare);
      if (!phone) continue;
      try {
        await api('inbound_phone', { user_id: userId, wa_id: bare, phone, name: c?.name || c?.notify || null });
        console.log(`[bridge] resolved phone for LID ${bare}`);
      } catch (e) {
        console.warn('[bridge] phone patch failed:', e.message);
      }
    }
  };
  sock.ev.on('contacts.upsert', onContacts);
  sock.ev.on('contacts.update', onContacts);


  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try {
        if (msg.key?.fromMe) continue;
        const remoteJid = msg.key?.remoteJid || '';
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;
        const sender = extractSender(msg);
        if (!sender) {
          console.warn('[bridge] skipped inbound: no supported sender ID');
          continue;
        }
        const { ctwa_clid, ad_id, source_type } = extractReferral(msg);
        if (sender.phone && sender.lid) rememberLidPhone(sender.lid, sender.phone);
        const phone = sender.phone || (await resolvePhoneFromLid(sock, sender.lid));

        const result = await api('inbound', {
          user_id: userId,
          wa_id: sender.waId,
          is_lid: sender.isLid,
          phone,
          name: msg.pushName || null,
          ctwa_clid,
          ad_id,
          source_type,
        });
        if (result.success) {
          console.log(`[bridge] inbound contact saved for ${userId} (phone: ${phone || 'unresolved'})`);
        }

      } catch (e) {
        console.warn('[bridge] inbound failed:', e.message);
      }
    }
  });
}

async function stopSession(userId) {
  const entry = sessions.get(userId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch { try { entry.sock.end(); } catch {} }
  }
  sessions.delete(userId);
  await api('set_status', { user_id: userId, status: 'disconnected', clear_creds: true });
}

async function tick() {
  const res = await api('poll');
  const list = res.sessions || [];
  const wanted = new Set();

  for (const s of list) {
    if (s.status === 'logout_requested') {
      await stopSession(s.user_id);
      continue;
    }
    wanted.add(s.user_id);
    if (!sessions.has(s.user_id)) {
      console.log(`[bridge] starting session for ${s.user_id} (${s.status})`);
      startSession(s.user_id, s.creds).catch((e) => {
        sessions.delete(s.user_id);
        const message = e instanceof Error ? e.message : String(e);
        console.warn('[bridge] start failed:', message);
        api('set_status', { user_id: s.user_id, status: 'disconnected', error: `Bridge start failed: ${message}` });
      });
    }
  }

  // Sessions no longer wanted by the app
  for (const userId of [...sessions.keys()]) {
    if (!wanted.has(userId)) await stopSession(userId);
  }
}

console.log('[bridge] BillStock Pro WhatsApp bridge started');
tick().catch((e) => console.warn('[bridge] tick error:', e.message));
setInterval(() => { tick().catch((e) => console.warn('[bridge] tick error:', e.message)); }, POLL_INTERVAL);
