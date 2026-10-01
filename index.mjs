/**
 * BillStock Pro — WhatsApp link-device bridge
 *
 * Holds one WhatsApp Web companion session per shop, uploads the pairing QR,
 * reports incoming messages to the app, and delivers replies queued by Inbox.
 */
import 'dotenv/config';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
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

// Sent with every call so the app can tell which link-server build is live.
const BRIDGE_VERSION = 'v4-baileys7';
const INSTANCE = Math.random().toString(36).slice(2, 8);

/** Forward important events to the app's logs (Railway logs are hard to reach). */
function report(event, data = {}) {
  api('log', { event, ...data }).catch(() => {});
}

/** userId -> { sock, saveTimer, closing } */
const sessions = new Map();

/** Recent message bodies (id -> proto.Message) for WhatsApp's decrypt-retry flow. */
const recentMessages = new Map();
function rememberSent(msg) {
  const id = msg?.key?.id;
  if (!id || !msg?.message) return;
  recentMessages.set(id, msg.message);
  if (recentMessages.size > 2000) recentMessages.delete(recentMessages.keys().next().value);
}

async function api(action, payload = {}) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': BRIDGE_TOKEN },
    body: JSON.stringify({ action, bridge_version: BRIDGE_VERSION, instance: INSTANCE, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.success && action !== 'log') console.warn(`[bridge] ${action} failed:`, out.error || res.status);
  return out;
}

async function uploadInboundMedia(userId, messageId, media) {
  const buffer = await downloadMediaMessage(media.source, 'buffer', {}, { logger });
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': media.mime || 'application/octet-stream',
      'x-bridge-token': BRIDGE_TOKEN,
      'x-bridge-action': 'upload_media',
      'x-user-id': userId,
      'x-message-id': messageId,
      'x-media-type': media.type,
      'x-file-name': encodeURIComponent(media.name || ''),
    },
    body: buffer,
  });
  const out = await res.json().catch(() => ({}));
  if (!out.success) throw new Error(out.error || `Media upload failed (${res.status})`);
  return out;
}

/** Auth state kept in the app database so the worker can be redeployed freely. */
function makeRemoteAuthState(userId, stored) {
  const parsed = stored ? JSON.parse(JSON.stringify(stored), BufferJSON.reviver) : null;
  const state = {
    creds: parsed?.creds || initAuthCreds(),
    keys: parsed?.keys || {},
  };

  // One save at a time, always the newest snapshot. Parallel saves could land
  // out of order and leave an older key set in the database; reloading that
  // after a reconnect breaks encryption ("Waiting for this message").
  let saving = null;
  let dirty = false;
  const persist = () => {
    dirty = true;
    if (saving) return saving;
    saving = (async () => {
      while (dirty) {
        dirty = false;
        await api('save_creds', {
          user_id: userId,
          creds: JSON.parse(JSON.stringify({ creds: state.creds, keys: state.keys }, BufferJSON.replacer)),
        });
      }
    })().finally(() => { saving = null; });
    return saving;
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

/** Peel the wrapper layers WhatsApp puts around the real message. */
function unwrapContent(message) {
  let content = message || {};
  for (let i = 0; i < 6; i++) {
    const inner =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message ||
      content.deviceSentMessage?.message ||
      content.editedMessage?.message ||
      null;
    if (!inner) break;
    content = inner;
  }
  return content;
}

/** True when the message has nothing a person wrote (keys, receipts, reactions…). */
function isSystemOnly(content) {
  const keys = Object.keys(content || {}).filter((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
  if (keys.length === 0) return true;
  return keys.every((k) => k === 'protocolMessage' || k === 'reactionMessage' || k === 'pollUpdateMessage' || k === 'keepInChatMessage');
}

function messageContent(msg) {
  const content = unwrapContent(msg?.message);
  const text = content.conversation || content.extendedTextMessage?.text ||
    content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText || content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    (content.contactMessage ? `👤 ${content.contactMessage.displayName || 'Contact'}` : null) ||
    (content.locationMessage ? `📍 https://maps.google.com/?q=${content.locationMessage.degreesLatitude},${content.locationMessage.degreesLongitude}` : null) ||
    null;
  if (content.imageMessage) return { text, type: 'image', source: msg, mime: content.imageMessage.mimetype || 'image/jpeg', name: null };
  if (content.videoMessage) return { text, type: 'video', source: msg, mime: content.videoMessage.mimetype || 'video/mp4', name: null };
  if (content.audioMessage) return { text, type: 'audio', source: msg, mime: content.audioMessage.mimetype || 'audio/ogg', name: null };
  if (content.documentMessage) return { text, type: 'file', source: msg, mime: content.documentMessage.mimetype || 'application/octet-stream', name: content.documentMessage.fileName || 'file' };
  if (content.stickerMessage) return { text: null, type: 'image', source: msg, mime: content.stickerMessage.mimetype || 'image/webp', name: 'sticker.webp' };
  return { text, type: 'text', source: null, mime: null, name: null };
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

function recipientJid(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) return value;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 10 ? `${digits}@s.whatsapp.net` : null;
}

async function deliverOutbox(userId, sock) {
  const result = await api('outbox', { user_id: userId });
  for (const item of result.messages || []) {
    const jid = recipientJid(item.wa_id);
    if (!jid) {
      await api('outbox_ack', { user_id: userId, id: item.id, error: 'গ্রাহকের WhatsApp নম্বর পাওয়া যায়নি' });
      continue;
    }

    try {
      let sent = null;
      const attachments = Array.isArray(item.attachments) && item.attachments.length
        ? item.attachments
        : item.media_url ? [{ type: item.content_type, url: item.media_url, name: item.file_name }] : [];
      if (!attachments.length) {
        sent = await sock.sendMessage(jid, { text: String(item.text || '') });
      } else {
        for (let i = 0; i < attachments.length; i++) {
          const attachment = attachments[i];
          const media = { url: attachment.url };
          const caption = i === 0 ? item.text || undefined : undefined;
          if (attachment.type === 'image') sent = await sock.sendMessage(jid, { image: media, caption });
          else if (attachment.type === 'video') sent = await sock.sendMessage(jid, { video: media, caption });
          else if (attachment.type === 'audio') sent = await sock.sendMessage(jid, { audio: media, mimetype: attachment.mime || 'audio/ogg', ptt: false });
          else sent = await sock.sendMessage(jid, { document: media, fileName: attachment.name || 'attachment', caption });
        }
      }
      rememberSent(sent);
      await api('outbox_ack', {
        user_id: userId,
        id: item.id,
        message_id: sent?.key?.id || null,
      });
      console.log(`[bridge] delivered inbox reply ${item.id}`);
      report('send_ok', { user_id: userId, jid, message_id: sent?.key?.id || null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await api('outbox_ack', { user_id: userId, id: item.id, error: message });
      console.warn(`[bridge] reply ${item.id} failed:`, message);
      report('send_failed', { user_id: userId, jid, error: message });
    }
  }
}



/** userId -> live auth state, reused across reconnects so keys never roll back. */
const authStates = new Map();

async function startSession(userId, storedCreds) {
  if (sessions.has(userId)) return;
  sessions.set(userId, { starting: true });

  let auth = authStates.get(userId);
  if (!auth) {
    auth = makeRemoteAuthState(userId, storedCreds);
    authStates.set(userId, auth);
  }
  const { state, persist } = auth;

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
    maxMsgRetryCount: 5,
    // Needed so WhatsApp can re-encrypt a message when the other phone asks
    // for a retry; without it some messages never decrypt.
    getMessage: async (key) => recentMessages.get(key?.id || '') || undefined,
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
      report('connected', { user_id: userId, wa_version: version.join('.') });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sessions.delete(userId);
      if (loggedOut) authStates.delete(userId);
      else await persist().catch(() => {});
      await api('set_status', {
        user_id: userId,
        status: 'disconnected',
        clear_creds: loggedOut,
        error: loggedOut ? 'Device unlinked from WhatsApp' : `WhatsApp socket closed (${code || 'unknown'}); retrying`,
      });
      console.log(`[bridge] ${userId} closed (code ${code || 'n/a'})`);
      report('closed', { user_id: userId, code: code || null, error: lastDisconnect?.error?.message || null });
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

  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates || []) {
      const messageId = update?.key?.id;
      if (!messageId || !update?.key?.fromMe) continue;
      const status = Number(update.update?.status || 0);
      if (status >= Number(proto.WebMessageInfo.Status.DELIVERY_ACK || 3)) {
        report('status', { user_id: userId, id: messageId, status });
        await api('message_status', {
          user_id: userId,
          message_id: messageId,
          read: status >= Number(proto.WebMessageInfo.Status.READ || 4),
        });
      }
    }
  });


  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try {
        if (msg.key?.fromMe) continue;
        const remoteJid = msg.key?.remoteJid || '';
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;
        // Not decrypted yet ("Waiting for this message"). WhatsApp re-sends it
        // after the key retry and Baileys emits it again with the real content
        // under the same id — reporting the empty copy would hide the real one.
        if (!msg.message) {
          console.log(`[bridge] message ${msg.key?.id} not decrypted yet (stub ${msg.messageStubType || 'n/a'}); waiting for retry`);
          report('undecrypted', { user_id: userId, id: msg.key?.id, jid: remoteJid, stub: msg.messageStubType || null, params: msg.messageStubParameters || null });
          continue;
        }
        if (isSystemOnly(unwrapContent(msg.message))) continue;
        rememberSent(msg);
        report('inbound_decrypted', { user_id: userId, id: msg.key?.id, jid: remoteJid });
        const sender = extractSender(msg);
        if (!sender) {
          console.warn('[bridge] skipped inbound: no supported sender ID');
          continue;
        }
        const { ctwa_clid, ad_id, source_type } = extractReferral(msg);
        const content = messageContent(msg);
        const messageId = String(msg.key?.id || '');
        if (sender.phone && sender.lid) rememberLidPhone(sender.lid, sender.phone);
        const phone = sender.phone || (await resolvePhoneFromLid(sock, sender.lid));
        let mediaUrl = null;
        if (content.source && messageId) {
          try {
            const uploaded = await uploadInboundMedia(userId, messageId, content);
            mediaUrl = uploaded.url || null;
          } catch (e) {
            console.warn(`[bridge] media ${messageId} failed:`, e instanceof Error ? e.message : String(e));
          }
        }

        const result = await api('inbound', {
          user_id: userId,
          wa_id: sender.waId,
          is_lid: sender.isLid,
          phone,
          name: msg.pushName || null,
          ctwa_clid,
          ad_id,
          source_type,
          text: content.text,
          media_type: content.type,
          media_url: mediaUrl,
          file_name: content.name,
          media_mime: content.mime,
          message_id: messageId || null,
          created_at: msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : null,
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
  authStates.delete(userId);
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
    } else {
      const entry = sessions.get(s.user_id);
      if (entry?.sock?.user) await deliverOutbox(s.user_id, entry.sock);
    }
  }

  // Sessions no longer wanted by the app
  for (const userId of [...sessions.keys()]) {
    if (!wanted.has(userId)) await stopSession(userId);
  }
}

console.log(`[bridge] BillStock Pro WhatsApp bridge started (${BRIDGE_VERSION}, instance ${INSTANCE})`);
report('boot', { node: process.version });
tick().catch((e) => console.warn('[bridge] tick error:', e.message));
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try { await tick(); } catch (e) { console.warn('[bridge] tick error:', e.message); }
  finally { ticking = false; }
}, POLL_INTERVAL);
