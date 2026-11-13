'use strict';

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const NodeCache = require('node-cache');

const config = require('../config/settings');
const logger = require('../utils/logger');
const { resolveSession, SESSION_DIR } = require('../utils/session');
const { seedDefaults, initPersistentSettings, getSetting } = require('../db/database');
const { loadPlugins } = require('./loader');
const { handleMessage } = require('./message');
const { handleGroupUpdate, handleGroupSettingsUpdate } = require('./group');
const { autoUpdate } = require('../utils/autoUpdate');

const {
    PantherAntiCall,
    PantherAutoBio,
    PantherAntiDelete,
    PantherAntiEdit,
    storeMessage,
    getStoredMessage,
    channelCtx,
} = require('../utils/gmdFunctions2');

const { initStatusEngine, enqueueAll } = require('../utils/statusEngine');
const { getCached, invalidate: invalidateGroupCache } = require('../utils/groupCache');
const { handleStatusBroadcast } = require('./statusManager');

seedDefaults({
    BOT_NAME: config.BOT_NAME,
    OWNER_NAME: config.OWNER_NAME,
    OWNER_NUMBER: config.OWNER_NUMBER,
    BOT_PREFIX: config.BOT_PREFIX,
    MODE: config.MODE,
    AUTO_REACT: String(config.AUTO_REACT),
    AUTO_BIO: String(config.AUTO_BIO),
    AUTO_READ_STATUS: String(config.AUTO_READ_STATUS),
    AUTO_LIKE_STATUS: String(config.AUTO_LIKE_STATUS),
});

let sock;
let reconnectCount = 0;

const MAX_RECONNECT_DELAY = 30000;
const CONNECTION_MESSAGE_EXPIRATION = 180;

if (!global._followedNewsletters) global._followedNewsletters = new Set();

let _cachedVersion = null;

async function getBaileysVersion() {
    if (_cachedVersion) return _cachedVersion;

    try {
        const { version } = await fetchLatestBaileysVersion();
        _cachedVersion = version;
    } catch {
        _cachedVersion = [2, 3000, 1015901307];
    }

    setTimeout(() => { _cachedVersion = null; }, 3600000);
    return _cachedVersion;
}

const silentLogger = pino({ level: 'silent', enabled: false });

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function autoFollowChannel(sock) {
    if (!config.AUTO_FOLLOW_CHANNEL) return;

    const jid = config.CHANNEL_JID;
    if (!jid?.endsWith('@newsletter')) return;
    if (global._followedNewsletters.has(jid)) return;

    try {
        await sock.newsletterFollow(jid);
        global._followedNewsletters.add(jid);
        logger.success('CHANNEL', `Following channel: ${config.CHANNEL_NEWSLETTER_NAME}`);
    } catch (e) {
        if (/already|409|subscribed|unexpected response/i.test(e.message || '')) {
            global._followedNewsletters.add(jid);
        } else {
            logger.warn('CHANNEL', e.message);
        }
    }
}

async function autoFollowInbound(sock, jid) {
    if (!jid?.endsWith('@newsletter')) return;
    if (global._followedNewsletters.has(jid)) return;

    try {
        await sock.newsletterFollow(jid);
        global._followedNewsletters.add(jid);
    } catch (e) {
        if (/already|409|subscribed|unexpected response/i.test(e.message || '')) {
            global._followedNewsletters.add(jid);
        }
    }
}

async function autoJoinGroups(sock) {
    const raw = config.AUTO_JOIN_GROUPS || '';
    if (!raw.trim()) return;

    for (const code of raw.split(',').map(c => c.trim()).filter(Boolean)) {
        try {
            await sock.groupAcceptInvite(code);
            logger.success('AUTOJOIN', `Joined group: ${code}`);
        } catch (e) {
            logger.warn('AUTOJOIN', e.message);
        }
    }
}

async function startBot() {
    // Load the durable ON/OFF state before plugins and message handlers start.
    try {
        await initPersistentSettings();
        const jsonSettingsDb = await import('../../guruh/database/config.js');
        await jsonSettingsDb.initPersistentDatabase();
        const boolKeys = new Set([
            'AUTO_REACT', 'AUTO_BIO', 'AUTO_READ_STATUS', 'AUTO_LIKE_STATUS',
            'AUTO_TYPING', 'AUTO_RECORDING', 'GHOST_MODE', 'FREEZE_LAST_SEEN',
            'ANTI_CALL', 'ANTICALL', 'ANTIDELETE', 'ANTIEDIT', 'STATUS_REPLY',
        ]);
        for (const key of Object.keys(config)) {
            const saved = getSetting(key, null);
            if (saved === null) continue;
            config[key] = boolKeys.has(key)
                ? ['true', '1', 'on', 'yes'].includes(String(saved).toLowerCase())
                : (typeof config[key] === 'number' ? Number(saved) : saved);
        }
        global.autoPresenceFlags = {
            typing: getSetting('AUTO_TYPING', String(config.AUTO_TYPING)) === 'true',
            recording: getSetting('AUTO_RECORDING', String(config.AUTO_RECORDING)) === 'true',
        };
    } catch (error) {
        logger.error('DB', `Persistent settings initialization failed: ${error.message}`);
        throw error;
    }

    if (config.AUTO_UPDATE) {
        try {
            await autoUpdate();
        } catch (e) {
            logger.warn('UPDATE', e.message);
        }
    }

    logger.banner(
        config.BOT_NAME,
        config.OWNER_NAME,
        config.OWNER_NUMBER,
        config.BOT_PREFIX,
        config.MODE,
        config.BOT_VERSION
    );

    await resolveSession();
    await loadPlugins();
    ensureDir(SESSION_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const version = await getBaileysVersion();

    const userDevicesCache = new NodeCache({ stdTTL: 600, useClones: false });

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
        },
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['BLACK PANTHER MD', 'Chrome', '121.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        retryRequestDelayMs: 50,
        maxMsgRetryCount: 3,
        keepAliveIntervalMs: 15000,
        connectTimeoutMs: 20000,
        defaultQueryTimeoutMs: 15000,
        qrTimeout: 0,
        emitOwnEvents: true,
        getMessage: async key => getStoredMessage(key?.id),
        cachedGroupMetadata: async jid => getCached(jid) ?? undefined,
        userDevicesCache,
        patchMessageBeforeSending: message => {
            if (message.buttonsMessage || message.templateMessage || message.listMessage) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...message,
                        },
                    },
                };
            }
            return message;
        },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            if (logger.IS_HEROKU) {
                logger.error('QR', 'Invalid session. Set a valid SESSION_ID.');
                process.exit(1);
            }

            logger.warn('QR', 'Scan QR code to connect.');
            try {
                require('qrcode-terminal').generate(qr, { small: true });
            } catch {}
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === code) || code;

            if (code === DisconnectReason.loggedOut) {
                logger.error('CONNECTION', 'Logged out. Use a fresh session.');
                process.exit(1);
            }

            if (code === DisconnectReason.connectionReplaced) {
                logger.warn('CONNECTION', 'Session replaced.');
                process.exit(1);
            }

            reconnectCount++;
            const delay = Math.min(
                1000 * Math.pow(2, Math.min(reconnectCount - 1, 5)),
                MAX_RECONNECT_DELAY
            );

            logger.warn('CONNECTION', `Closed (${reason}). Reconnecting in ${delay / 1000}s`);
            setTimeout(startBot, delay);
        }

        if (connection === 'open') {
            reconnectCount = 0;
            initStatusEngine(sock);

            const botJid = sock.user?.id || '';
            const sessionNumber = botJid.split(':')[0].split('@')[0];

            const ownerNumber =
                String(config.OWNER_NUMBER || '').replace(/\D/g, '') ||
                sessionNumber;

            const ownerJid = ownerNumber
                ? `${ownerNumber}@s.whatsapp.net`
                : null;

            logger.success('CONNECTION', `Connected as ${botJid}`);

            const now = new Date().toLocaleTimeString('en-KE', {
                timeZone: config.TIME_ZONE,
            });

            const today = new Date().toLocaleDateString('en-KE', {
                timeZone: config.TIME_ZONE,
            });

            const startText =
`╭─❖ *${config.BOT_NAME}* ❖─╮
│
├─❖ *Status:* ✅ ONLINE
├─❖ *Owner:* ${config.OWNER_NAME}
├─❖ *Phone:* +${ownerNumber}
├─❖ *Prefix:* [ ${config.BOT_PREFIX} ]
├─❖ *Mode:* ${config.MODE.toUpperCase()}
├─❖ *Host:* ${logger.PLATFORM}
├─❖ *Version:* ${config.BOT_VERSION}
├─❖ *Time:* ${now}
├─❖ *Date:* ${today}
│
╰─❖ *Powered by ${config.OWNER_NAME}* ❖─╯

> © ${config.BOT_NAME} is awesome 🔥`;

            if (ownerJid) {
                sock.sendMessage(
                    ownerJid,
                    {
                        text: startText,
                        contextInfo: channelCtx(),
                    },
                    {
                        disappearingMessagesInChat: true,
                        ephemeralExpiration: CONNECTION_MESSAGE_EXPIRATION,
                    }
                ).catch(() => {});
            }

            if (config.AUTO_BIO) {
                PantherAutoBio(sock).catch(() => {});
                setInterval(() => PantherAutoBio(sock).catch(() => {}), 600000);
            }

            setTimeout(() => autoFollowChannel(sock).catch(() => {}), 5000);
            setTimeout(() => autoJoinGroups(sock).catch(() => {}), 8000);
        }
    });

    sock.ev.on('messages.upsert', async upsert => {
        if (!upsert?.messages) return;

        if (upsert.type === 'notify') {
            const nonStatus = upsert.messages.filter(
                m => m?.key?.remoteJid !== 'status@broadcast'
            );
            if (nonStatus.length) enqueueAll(nonStatus);
        }

        for (const msg of upsert.messages) storeMessage(msg);

        for (const msg of upsert.messages) {
            const revoke = msg?.message?.protocolMessage;

            if (revoke?.type === 0 && revoke?.key?.id) {
                PantherAntiDelete(sock, {
                    ...revoke.key,
                    remoteJid: revoke.key.remoteJid || msg.key?.remoteJid,
                }).catch(() => {});
            }
        }

        for (const msg of upsert.messages) {
            const jid = msg?.key?.remoteJid || '';

            if (jid === 'status@broadcast' && msg?.key?.participant) {
                handleStatusBroadcast(sock, msg).catch(e =>
                    logger.warn('StatusMgr', e.message)
                );
                continue;
            }

            if (jid.endsWith('@newsletter') && msg?.key?.id) {
                autoFollowInbound(sock, jid).catch(() => {});

                if (process.uptime() > 25) {
                    const serverId = msg.key.server_id || msg.key.id;
                    const isOwnChannel = jid === config.CHANNEL_JID;

                    const emoji = isOwnChannel
                        ? '❤️‍🔥'
                        : ['❤️‍🔥', '🦨', '🦇', '🦅', '🦕', '🦖', '🦎', '🐲', '🐺', '🦊']
                            [Math.floor(Math.random() * 10)];

                    if (serverId) {
                        sock.newsletterReactMessage(jid, serverId, emoji).catch(() => {});
                    } else {
                        sock.sendMessage(jid, {
                            react: { text: emoji, key: msg.key },
                        }).catch(() => {});
                    }
                }
            }
        }

        handleMessage(upsert, sock);
    });

    sock.ev.on('messages.delete', item => {
        if (!item?.keys) return;

        for (const key of item.keys) {
            PantherAntiDelete(sock, key).catch(() => {});
        }
    });

    sock.ev.on('messages.update', async updates => {
        for (const update of updates) {
            if (update?.update?.message?.protocolMessage?.editedMessage) {
                PantherAntiEdit(sock, update).catch(() => {});
            }
        }
    });

    sock.ev.on('group-participants.update', event => {
        invalidateGroupCache(event?.id);
        handleGroupUpdate(event, sock);
    });

    sock.ev.on('groups.update', events => {
        for (const event of events || []) invalidateGroupCache(event?.id);
        handleGroupSettingsUpdate(events, sock);
    });

    sock.ev.on('call', calls => PantherAntiCall(calls, sock));

    return sock;
}

function getSocket() {
    return sock;
}

module.exports = { startBot, getSocket };
