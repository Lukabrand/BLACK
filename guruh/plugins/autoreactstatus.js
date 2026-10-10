'use strict';

const db = require('../../guru/db/database');
const { getBotName } = require('../botname');
const { addCmd } = require('../../guru/handlers/loader');
const config = require('../../guru/config/settings');

const CONFIG_DB_KEY = 'autoreact_config';

const DEFAULT_REACT_CONFIG = {
    enabled: true,
    onlyOnOwnerReply: false,
    viewMode: 'view+react',
    mode: 'random',
    fixedEmoji: '💚',

    reactions: [
        '💚', '💜', '❤️', '💙', '🖤', '🤍',
        '🔥', '🎉', '😂', '😮', '👏', '💯',
        '🌟', '✨', '⚡', '💥', '🫶', '😍',
        '🥰', '😘', '😎', '🥳', '🤩', '💖',
        '💘', '💕', '💞', '💗', '💋', '👍',
        '🙌', '🥹', '🤗', '🐺'
    ],

    cycleIndex: 0,
    excludedContacts: [],
    logs: [],
    totalReacted: 0,
    lastReacted: null,
    consecutiveReactions: 0,
    lastSender: null,
    lastReactionTime: 0,
    reactedStatuses: [],

    settings: {
        rateLimitDelay: 2000,
        reactToAll: true,
        ignoreConsecutiveLimit: true,
        noHourlyLimit: true
    }
};

class AutoReactManager {
    constructor() {
        this.config = this.loadConfig();
        this.lastReactionTime = this.config.lastReactionTime || 0;
        this.reactedStatuses = new Set(
            this.config.reactedStatuses || []
        );

        this._queue = [];
        this._draining = false;
        this._saveTimer = null;

        this.cleanupOldReactedStatuses();
    }

    loadConfig() {
        try {
            const saved =
                db.getConfigSync(CONFIG_DB_KEY, DEFAULT_REACT_CONFIG) || {};

            const merged = {
                ...DEFAULT_REACT_CONFIG,
                ...saved,

                reactions: Array.isArray(saved.reactions)
                    ? saved.reactions
                    : [...DEFAULT_REACT_CONFIG.reactions],

                excludedContacts: Array.isArray(saved.excludedContacts)
                    ? saved.excludedContacts
                    : [],

                logs: Array.isArray(saved.logs)
                    ? saved.logs
                    : [],

                reactedStatuses: Array.isArray(saved.reactedStatuses)
                    ? saved.reactedStatuses
                    : [],

                settings: {
                    ...DEFAULT_REACT_CONFIG.settings,
                    ...(saved.settings || {})
                }
            };

            merged.mode = ['random', 'fixed', 'cycle'].includes(merged.mode)
                ? merged.mode
                : 'random';

            merged.viewMode =
                merged.viewMode === 'react-only'
                    ? 'react-only'
                    : 'view+react';

            merged.onlyOnOwnerReply = !!saved.onlyOnOwnerReply;

            return merged;
        } catch (error) {
            console.error('[AUTOREACT] Load error:', error.message);

            return {
                ...DEFAULT_REACT_CONFIG,
                reactions: [...DEFAULT_REACT_CONFIG.reactions],
                settings: { ...DEFAULT_REACT_CONFIG.settings }
            };
        }
    }

    saveConfig() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
        }

        this._saveTimer = setTimeout(() => {
            try {
                this.config.reactedStatuses =
                    Array.from(this.reactedStatuses);

                this.config.lastReactionTime =
                    this.lastReactionTime;

                Promise.resolve(
                    db.setConfig(CONFIG_DB_KEY, this.config)
                ).catch(() => {});
            } catch (error) {
                console.error('[AUTOREACT] Save error:', error.message);
            }

            this._saveTimer = null;
        }, 1000);
    }

    saveConfigImmediate() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }

        try {
            this.config.reactedStatuses =
                Array.from(this.reactedStatuses);

            this.config.lastReactionTime =
                this.lastReactionTime;

            Promise.resolve(
                db.setConfig(CONFIG_DB_KEY, this.config)
            ).catch(() => {});
        } catch (error) {
            console.error('[AUTOREACT] Save error:', error.message);
        }
    }

    cleanupOldReactedStatuses() {
        const now = Date.now();
        let cleaned = false;

        for (const key of Array.from(this.reactedStatuses)) {
            const parts = key.split('|');
            const timestamp = Number(parts[parts.length - 1]);

            if (
                parts.length >= 3 &&
                Number.isFinite(timestamp) &&
                now - timestamp > 24 * 60 * 60 * 1000
            ) {
                this.reactedStatuses.delete(key);
                cleaned = true;
            }
        }

        if (cleaned) {
            this.saveConfig();
        }
    }

    get enabled() {
        return this.config.enabled;
    }

    get viewMode() {
        return this.config.viewMode;
    }

    get mode() {
        return this.config.mode;
    }

    get fixedEmoji() {
        return this.config.fixedEmoji;
    }

    get reactions() {
        return this.config.reactions;
    }

    get logs() {
        return this.config.logs;
    }

    get totalReacted() {
        return this.config.totalReacted;
    }

    _normalizeNum(input) {
        return String(input || '').replace(/[^0-9]/g, '');
    }

    isExcluded(statusKey) {
        const list = this.config.excludedContacts || [];

        if (!list.length) {
            return false;
        }

        const jids = [
            statusKey.participantPn,
            statusKey.participant,
            statusKey.remoteJidAlt,
            statusKey.remoteJid
        ].filter(Boolean);

        const numbers = jids.map(jid =>
            jid.split('@')[0].split(':')[0]
        );

        return list.some(number => numbers.includes(number));
    }

    excludeContact(input) {
        const number = this._normalizeNum(input);

        if (!number) {
            return false;
        }

        if (!this.config.excludedContacts.includes(number)) {
            this.config.excludedContacts.push(number);
            this.saveConfigImmediate();
            return true;
        }

        return false;
    }

    includeContact(input) {
        const number = this._normalizeNum(input);
        const index = this.config.excludedContacts.indexOf(number);

        if (index !== -1) {
            this.config.excludedContacts.splice(index, 1);
            this.saveConfigImmediate();
            return true;
        }

        return false;
    }

    hasReacted(statusKey) {
        const sender =
            statusKey.participant ||
            statusKey.remoteJid ||
            '';

        const base = `${sender}|${statusKey.id}|`;

        for (const key of this.reactedStatuses) {
            if (key.startsWith(base)) {
                return true;
            }
        }

        return false;
    }

    markReacted(statusKey) {
        const sender =
            statusKey.participant ||
            statusKey.remoteJid ||
            '';

        const key =
            `${sender}|${statusKey.id}|${Date.now()}`;

        this.reactedStatuses.add(key);

        if (this.reactedStatuses.size > 500) {
            const entries = Array.from(this.reactedStatuses);
            this.reactedStatuses = new Set(entries.slice(-250));
        }

        this.saveConfig();
    }

    toggle(forceOff = false) {
        this.config.enabled = !forceOff;
        this.saveConfigImmediate();

        return this.config.enabled;
    }

    setOnlyOnOwnerReply(value) {
        this.config.onlyOnOwnerReply = !!value;
        this.saveConfigImmediate();
    }

    setViewMode(mode) {
        if (!['view+react', 'react-only'].includes(mode)) {
            return false;
        }

        this.config.viewMode = mode;
        this.saveConfigImmediate();

        return true;
    }

    setMode(mode) {
        if (!['random', 'fixed', 'cycle'].includes(mode)) {
            return false;
        }

        this.config.mode = mode;
        this.saveConfigImmediate();

        return true;
    }

    resetCycleIndex() {
        this.config.cycleIndex = 0;
        this.saveConfigImmediate();
    }

    setFixedEmoji(emoji) {
        if (
            typeof emoji === 'string' &&
            [...emoji].length >= 1 &&
            [...emoji].length <= 4
        ) {
            this.config.fixedEmoji = emoji;
            this.saveConfigImmediate();
            return true;
        }

        return false;
    }

    addReaction(emoji) {
        if (
            typeof emoji === 'string' &&
            !this.config.reactions.includes(emoji) &&
            [...emoji].length >= 1 &&
            [...emoji].length <= 4
        ) {
            this.config.reactions.push(emoji);
            this.saveConfigImmediate();
            return true;
        }

        return false;
    }

    removeReaction(emoji) {
        const index = this.config.reactions.indexOf(emoji);

        if (index !== -1) {
            this.config.reactions.splice(index, 1);
            this.saveConfigImmediate();
            return true;
        }

        return false;
    }

    resetReactions() {
        this.config.reactions = [
            '💚', '💜', '❤️', '💙', '🔥',
            '😂', '😍', '🥰', '💯', '✨',
            '⚡', '🎉', '👏', '🫶', '🐺'
        ];

        this.config.cycleIndex = 0;
        this.saveConfigImmediate();
    }

    // RANDOM MODE: Choose one random emoji for each status.
    getReaction() {
        if (this.config.mode === 'fixed') {
            return this.config.fixedEmoji || '💚';
        }

        const reactions = this.config.reactions || [];

        if (!reactions.length) {
            return '🐺';
        }

        if (this.config.mode === 'cycle') {
            const index =
                this.config.cycleIndex % reactions.length;

            const emoji = reactions[index];

            this.config.cycleIndex =
                (index + 1) % reactions.length;

            this.saveConfig();

            return emoji;
        }

        const randomIndex = Math.floor(
            Math.random() * reactions.length
        );

        return reactions[randomIndex];
    }

    addLog(sender, reaction, statusId) {
        const entry = {
            sender,
            reaction,
            statusId,
            timestamp: Date.now()
        };

        this.config.logs.push(entry);
        this.config.totalReacted++;
        this.config.lastReacted = entry;

        this.config.consecutiveReactions =
            this.config.lastSender === sender
                ? this.config.consecutiveReactions + 1
                : 1;

        this.config.lastSender = sender;

        if (this.config.logs.length > 100) {
            this.config.logs.shift();
        }

        this.saveConfig();
    }

    clearLogs() {
        Object.assign(this.config, {
            logs: [],
            totalReacted: 0,
            lastReacted: null,
            consecutiveReactions: 0,
            lastSender: null
        });

        this.reactedStatuses.clear();
        this.saveConfigImmediate();
    }

    getStats() {
        return {
            enabled: this.config.enabled,
            onlyOnOwnerReply: this.config.onlyOnOwnerReply,
            viewMode: this.config.viewMode,
            mode: this.config.mode,
            fixedEmoji: this.config.fixedEmoji,
            reactions: [...this.config.reactions],
            totalReacted: this.config.totalReacted,
            lastReacted: this.config.lastReacted,
            consecutiveReactions: this.config.consecutiveReactions,
            reactedStatusesCount: this.reactedStatuses.size,
            excludedCount: this.config.excludedContacts.length,
            settings: { ...this.config.settings }
        };
    }

    enqueue(sock, statusKey) {
        if (!this.config.enabled) return;
        if (!statusKey || !statusKey.id) return;
        if (this.config.onlyOnOwnerReply) return;
        if (this.hasReacted(statusKey)) return;
        if (this.isExcluded(statusKey)) return;

        this.markReacted(statusKey);

        const sender =
            statusKey.participantPn ||
            statusKey.participant ||
            statusKey.remoteJid ||
            '';

        const displayId =
            '+' + sender.split('@')[0].split(':')[0];

        this._queue.push({
            sock,
            statusKey,
            displayId
        });

        this._drain();
    }

    _drain() {
        if (this._draining) {
            return;
        }

        this._draining = true;

        this._processNext()
            .catch(error => {
                console.error('[AUTOREACT] Queue error:', error.message);
            })
            .finally(() => {
                this._draining = false;

                if (this._queue.length > 0) {
                    this._drain();
                }
            });
    }

    async _processNext() {
        while (this._queue.length > 0) {
            const item = this._queue.shift();

            const delay = Math.max(
                0,
                Number(this.config.settings.rateLimitDelay) || 2000
            );

            const wait =
                delay - (Date.now() - this.lastReactionTime);

            if (wait > 0) {
                await new Promise(resolve =>
                    setTimeout(resolve, wait)
                );
            }

            await this._sendReaction(
                item.sock,
                item.statusKey,
                item.displayId
            );
        }
    }

    async _sendReaction(sock, statusKey, displayId) {
        try {
            const resolvedJid =
                statusKey.participantPn ||
                statusKey.remoteJidAlt ||
                (
                    statusKey.participant &&
                    !statusKey.participant.includes('@lid')
                        ? statusKey.participant
                        : null
                ) ||
                statusKey.participant ||
                statusKey.remoteJid;

            if (!resolvedJid) {
                return;
            }

            if (this.config.viewMode === 'view+react') {
                try {
                    await sock.readMessages([{
                        remoteJid: 'status@broadcast',
                        id: statusKey.id,
                        fromMe: false,
                        participant: resolvedJid
                    }]);
                } catch (error) {
                    // Continue if marking the status as read fails.
                }
            }

            const emoji = this.getReaction();

            const rawBotId =
                sock.user?.id ||
                sock.user?.jid ||
                '';

            const botJid = rawBotId
                ? rawBotId.split(':')[0].split('@')[0] +
                    '@s.whatsapp.net'
                : '';

            await sock.sendMessage(
                'status@broadcast',
                {
                    react: {
                        text: emoji,
                        key: {
                            remoteJid: 'status@broadcast',
                            id: statusKey.id,
                            participant: resolvedJid,
                            fromMe: false
                        }
                    }
                },
                {
                    statusJidList: [
                        ...new Set([
                            resolvedJid,
                            ...(botJid ? [botJid] : [])
                        ])
                    ]
                }
            );

            this.lastReactionTime = Date.now();

            this.addLog(
                displayId,
                emoji,
                statusKey.id
            );

            console.log(
                `✅ [AUTOREACT] Reacted ${emoji} to status from ${displayId}`
            );
        } catch (error) {
            if (
                error.message?.includes('rate-overlimit') ||
                error.message?.includes('rate limit')
            ) {
                this.config.settings.rateLimitDelay = Math.min(
                    (Number(this.config.settings.rateLimitDelay) || 2000) * 2,
                    10000
                );

                this.saveConfig();
            }

            console.error(
                `❌ [AUTOREACT] Failed for ${displayId}: ${error.message}`
            );
        }
    }
}

const autoReactManager = new AutoReactManager();

globalThis._autoReactManager = autoReactManager;

globalThis._autoReactReload = () => {
    try {
        autoReactManager.config = autoReactManager.loadConfig();

        autoReactManager.lastReactionTime =
            autoReactManager.config.lastReactionTime || 0;

        autoReactManager.reactedStatuses = new Set(
            autoReactManager.config.reactedStatuses || []
        );
    } catch (error) {
        console.error('[AUTOREACT] Reload error:', error.message);
    }
};

async function handleAutoReact(sock, statusKey) {
    autoReactManager.enqueue(sock, statusKey);
}

async function triggerReactFromOwnerReply(sock, statusKey) {
    if (!autoReactManager.config.enabled) return;
    if (!autoReactManager.config.onlyOnOwnerReply) return;
    if (!statusKey || !statusKey.id) return;
    if (autoReactManager.hasReacted(statusKey)) return;
    if (autoReactManager.isExcluded(statusKey)) return;

    autoReactManager.markReacted(statusKey);

    const sender =
        statusKey.participantPn ||
        statusKey.participant ||
        statusKey.remoteJid ||
        '';

    const displayId =
        '+' + sender.split('@')[0].split(':')[0];

    autoReactManager._queue.push({
        sock,
        statusKey,
        displayId
    });

    autoReactManager._drain();
}

function wasAutoReacted(msgId) {
    if (!msgId) return false;

    for (const key of autoReactManager.reactedStatuses) {
        if (key.split('|')[1] === msgId) {
            return true;
        }
    }

    return false;
}

addCmd({
    name: 'autoreactstatus',

    aliases: [
        'reactstatus',
        'statusreact',
        'sr',
        'reacts',
        'autoreact',
        'autolike'
    ],

    desc: 'Automatically react to WhatsApp statuses',
    category: 'owner',
    ownerOnly: true,

    handler: async (ctx) => {
        try {
            const { args, reply, isOwner } = ctx;
            const prefix = config.BOT_PREFIX || '.';

            if (args.length === 0) {
                const s = autoReactManager.getStats();

                let text = `╭─⌈ 🎲 *AUTOREACT STATUS* ⌋\n`;
                text += `│\n`;
                text += `├─⊷ *${prefix}sr on / off*\n`;
                text += `├─⊷ *${prefix}sr random*\n`;
                text += `├─⊷ *${prefix}sr cycle*\n`;
                text += `├─⊷ *${prefix}sr fixed*\n`;
                text += `├─⊷ *${prefix}sr emoji ❤️*\n`;
                text += `├─⊷ *${prefix}sr setrandom ❤️,🔥,😂*\n`;
                text += `├─⊷ *${prefix}sr add ❤️*\n`;
                text += `├─⊷ *${prefix}sr remove ❤️*\n`;
                text += `├─⊷ *${prefix}sr view+react*\n`;
                text += `├─⊷ *${prefix}sr react-only*\n`;
                text += `├─⊷ *${prefix}sr exclude <number>*\n`;
                text += `├─⊷ *${prefix}sr include <number>*\n`;
                text += `├─⊷ *${prefix}sr excluded*\n`;
                text += `├─⊷ *${prefix}sr ownerreply*\n`;
                text += `├─⊷ *${prefix}sr list*\n`;
                text += `├─⊷ *${prefix}sr stats*\n`;
                text += `├─⊷ *${prefix}sr reset*\n`;
                text += `│\n`;
                text += `├─⊷ Status: ${s.enabled ? 'ACTIVE ✅' : 'INACTIVE ❌'}\n`;
                text += `├─⊷ Mode: ${s.mode.toUpperCase()}\n`;
                text += `├─⊷ Emoji pool: ${s.reactions.length}\n`;
                text += `╰─⊷ *Powered by ${getBotName().toUpperCase()}*`;

                await reply(text);
                return;
            }

            const action = args[0].toLowerCase();

            switch (action) {
                case 'on':
                case 'enable':
                case 'start': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.toggle(false);

                    await reply(
                        `✅ *AUTOREACT ENABLED*\n\n` +
                        `🎲 Mode: ${autoReactManager.mode.toUpperCase()}\n` +
                        `🎭 Emoji pool: ${autoReactManager.reactions.length}\n` +
                        `👁️ View mode: ${autoReactManager.viewMode}`
                    );
                    break;
                }

                case 'off':
                case 'disable':
                case 'stop': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.toggle(true);
                    await reply('❌ *AUTOREACT DISABLED*');
                    break;
                }

                case 'random': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.setMode('random');

                    await reply(
                        `🎲 *RANDOM MODE ENABLED*\n\n` +
                        `The bot will choose one random emoji for each status.\n\n` +
                        `${autoReactManager.reactions.join(' ')}`
                    );
                    break;
                }

                case 'cycle':
                case 'sequential': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.setMode('cycle');
                    autoReactManager.resetCycleIndex();

                    await reply(
                        `🔄 *CYCLE MODE ENABLED*\n\n` +
                        autoReactManager.reactions
                            .map((emoji, i) => `${i + 1}. ${emoji}`)
                            .join('\n')
                    );
                    break;
                }

                case 'fixed': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.setMode('fixed');

                    await reply(
                        `📌 *FIXED MODE ENABLED*\n\n` +
                        `Emoji: ${autoReactManager.fixedEmoji}`
                    );
                    break;
                }

                case 'emoji': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const emoji = args[1];

                    if (!emoji) {
                        await reply(
                            `Usage: ${prefix}sr emoji ❤️`
                        );
                        return;
                    }

                    if (autoReactManager.setFixedEmoji(emoji)) {
                        autoReactManager.setMode('fixed');

                        await reply(
                            `✅ Fixed emoji set to ${emoji}`
                        );
                    } else {
                        await reply('❌ Invalid emoji.');
                    }
                    break;
                }

                case 'setrandom':
                case 'setemojis':
                case 'setpool': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const emojis = args
                        .slice(1)
                        .join(' ')
                        .split(',')
                        .map(e => e.trim())
                        .filter(Boolean);

                    if (!emojis.length) {
                        await reply(
                            `Usage:\n${prefix}sr setrandom ❤️,🔥,😂,💯\n\n` +
                            `Current emojis:\n${autoReactManager.reactions.join(' ')}`
                        );
                        return;
                    }

                    const valid = [
                        ...new Set(
                            emojis.filter(e =>
                                [...e].length >= 1 &&
                                [...e].length <= 4 &&
                                /\p{Emoji}/u.test(e)
                            )
                        )
                    ];

                    if (!valid.length) {
                        await reply('❌ No valid emojis found.');
                        return;
                    }

                    autoReactManager.config.reactions = valid;
                    autoReactManager.config.cycleIndex = 0;
                    autoReactManager.setMode('random');
                    autoReactManager.saveConfigImmediate();

                    await reply(
                        `✅ *RANDOM EMOJI POOL UPDATED*\n\n` +
                        `📦 Total: ${valid.length}\n` +
                        `${valid.join(' ')}\n\n` +
                        `🎲 Mode: RANDOM`
                    );
                    break;
                }

                case 'view+react':
                case 'viewreact': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.setViewMode('view+react');

                    await reply(
                        '👁️ *VIEW + REACT MODE*\n\n' +
                        'The bot will attempt to view the status before reacting.'
                    );
                    break;
                }

                case 'react-only':
                case 'reactonly': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.setViewMode('react-only');

                    await reply(
                        '🎲 *REACT-ONLY MODE*\n\n' +
                        'The bot will attempt to react without first marking the status as read.'
                    );
                    break;
                }

                case 'ownerreply':
                case 'onlyownerreply':
                case 'replymode': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const current =
                        autoReactManager.config.onlyOnOwnerReply;

                    autoReactManager.setOnlyOnOwnerReply(!current);

                    await reply(
                        autoReactManager.config.onlyOnOwnerReply
                            ? '✅ *OWNER-REPLY MODE ON*\n\nThe bot will react only when the owner-reply trigger is called.'
                            : '🔄 *AUTO-REACT MODE ON*\n\nThe bot will process all eligible statuses.'
                    );
                    break;
                }

                case 'exclude':
                case 'skip':
                case 'block': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const number = args[1];

                    if (!number) {
                        await reply(
                            `Usage: ${prefix}sr exclude 255712345678`
                        );
                        return;
                    }

                    if (autoReactManager.excludeContact(number)) {
                        await reply(
                            `✅ Contact excluded.\n\n🚫 +${number.replace(/[^0-9]/g, '')}`
                        );
                    } else {
                        await reply(
                            '⚠️ Invalid number or contact already excluded.'
                        );
                    }
                    break;
                }

                case 'include':
                case 'unexclude':
                case 'unblock':
                case 'unskip': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const number = args[1];

                    if (!number) {
                        await reply(
                            `Usage: ${prefix}sr include 255712345678`
                        );
                        return;
                    }

                    if (autoReactManager.includeContact(number)) {
                        await reply('✅ Contact removed from exclusion list.');
                    } else {
                        await reply('⚠️ Contact was not excluded.');
                    }
                    break;
                }

                case 'excluded':
                case 'skiplist':
                case 'blocklist': {
                    const list = autoReactManager.config.excludedContacts;

                    if (!list.length) {
                        await reply('📭 No excluded contacts.');
                        return;
                    }

                    await reply(
                        `🚫 *EXCLUDED CONTACTS (${list.length})*\n\n` +
                        list.map((n, i) => `${i + 1}. +${n}`).join('\n')
                    );
                    break;
                }

                case 'list':
                case 'emojis': {
                    await reply(
                        `🎭 *EMOJI LIST (${autoReactManager.reactions.length})*\n\n` +
                        `${autoReactManager.reactions.join(' ')}\n\n` +
                        `Mode: ${autoReactManager.mode.toUpperCase()}`
                    );
                    break;
                }

                case 'add': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const emoji = args[1];

                    if (!emoji) {
                        await reply(`Usage: ${prefix}sr add ❤️`);
                        return;
                    }

                    if (autoReactManager.addReaction(emoji)) {
                        await reply(
                            `✅ ${emoji} added.\n\n` +
                            autoReactManager.reactions.join(' ')
                        );
                    } else {
                        await reply('⚠️ Emoji already exists or is invalid.');
                    }
                    break;
                }

                case 'remove': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    const emoji = args[1];

                    if (!emoji) {
                        await reply(`Usage: ${prefix}sr remove ❤️`);
                        return;
                    }

                    if (autoReactManager.removeReaction(emoji)) {
                        await reply(
                            `✅ ${emoji} removed.\n\n` +
                            autoReactManager.reactions.join(' ')
                        );
                    } else {
                        await reply('❌ Emoji not found.');
                    }
                    break;
                }

                case 'stats':
                case 'statistics':
                case 'info': {
                    const s = autoReactManager.getStats();

                    const modeLabel =
                        s.mode === 'fixed'
                            ? `FIXED (${s.fixedEmoji})`
                            : s.mode.toUpperCase();

                    let text = `╭─⌈ 📊 *AUTOREACT STATISTICS* ⌋\n`;
                    text += `│\n`;
                    text += `├─⊷ Status: ${s.enabled ? 'ACTIVE ✅' : 'INACTIVE ❌'}\n`;
                    text += `├─⊷ Trigger: ${s.onlyOnOwnerReply ? 'Owner reply' : 'All statuses'}\n`;
                    text += `├─⊷ View mode: ${s.viewMode}\n`;
                    text += `├─⊷ Emoji mode: ${modeLabel}\n`;
                    text += `├─⊷ Emoji pool: ${s.reactions.length}\n`;
                    text += `├─⊷ Total reacted: ${s.totalReacted}\n`;
                    text += `├─⊷ Tracked statuses: ${s.reactedStatusesCount}\n`;
                    text += `├─⊷ Excluded contacts: ${s.excludedCount}\n`;
                    text += `├─⊷ Queue: ${autoReactManager._queue.length}\n`;

                    if (s.lastReacted) {
                        const minutes = Math.floor(
                            (Date.now() - s.lastReacted.timestamp) / 60000
                        );

                        text += `├─⊷ Last reaction: ${s.lastReacted.reaction}\n`;
                        text += `├─⊷ Last sender: ${s.lastReacted.sender}\n`;
                        text += `├─⊷ Time: ${minutes < 1 ? 'Just now' : `${minutes} min ago`}\n`;
                    }

                    text += `╰─⊷ *Powered by ${getBotName().toUpperCase()}*`;

                    await reply(text);
                    break;
                }

                case 'reset':
                case 'clear': {
                    if (!isOwner) {
                        await reply('❌ Owner only!');
                        return;
                    }

                    autoReactManager.clearLogs();
                    autoReactManager.resetReactions();

                    await reply(
                        '🔄 *RESET COMPLETE*\n\n' +
                        'Logs cleared and default emojis restored.'
                    );
                    break;
                }

                default: {
                    await reply(
                        `❓ Unknown option.\n\nUse ${prefix}sr to view available commands.`
                    );
                }
            }
        } catch (error) {
            console.error(
                '[AUTOREACTSTATUS] Handler error:',
                error.message
            );
        }
    }
});

module.exports = {
    handleAutoReact,
    autoReactManager,
    triggerReactFromOwnerReply,
    wasAutoReacted
};
