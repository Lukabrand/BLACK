'use strict';
require('dotenv').config();

// ── Helper: env bool with explicit default ─────────────────────
const bool = (key, def = true) => {
    const v = process.env[key];
    if (v === undefined || v === '') return def;
    return v.toLowerCase() === 'true';
};

const config = {
    // ── Bot Identity ──────────────────────────────────
    BOT_NAME:       process.env.BOT_NAME     || 'BLACK PANTHER MD',
    OWNER_NAME:     process.env.OWNER_NAME   || 'GuruTech',
    OWNER_NUMBER:   process.env.OWNER_NUMBER || '254105521300',
    BOT_PREFIX:     process.env.BOT_PREFIX   || '.',
    PREFIX:         process.env.BOT_PREFIX   || '.',
    BOT_VERSION:    process.env.BOT_VERSION  || '1.0.0',
    VERSION:        process.env.BOT_VERSION  || '1.0.0',
    PACK_NAME:      process.env.PACK_NAME    || process.env.BOT_NAME || 'BLACK PANTHER MD',
    PACK_AUTHOR:    process.env.PACK_AUTHOR  || process.env.OWNER_NAME || 'GuruTech',
    BOT_LANG:       process.env.BOT_LANG     || 'en',
    BOT_BIO:        process.env.BOT_BIO      || 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʟᴜᴋᴀʙʀᴀɴᴅ 🚀',
    BOT_PIC:        process.env.BOT_PIC      || 'https://i.imgur.com/9VP31oG.png',
    BOT_REPO:       process.env.BOT_REPO     || 'Lukabrand/LUKA-XMD',
    CAPTION:        process.env.CAPTION      || '⚡ BLACK PANTHER MD Premium | Ultra Fast',
    FOOTER:         process.env.FOOTER       || 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʟᴜᴋᴀʙʀᴀɴᴅ',
    MENU_THEME:     process.env.MENU_THEME   || 'ultra',

    // ── Channel ───────────────────────────────────────
    CHANNEL_URL: process.env.CHANNEL_URL ||
        'https://whatsapp.com/channel/0029VbCl2UX3rZZilMSvxN1e',
    CHANNEL_NAME: process.env.CHANNEL_NAME || 'BLACK PANTHER MD Channel',
    CHANNEL_JID: process.env.CHANNEL_JID ||
        '120363427012090993@newsletter',
    CHANNEL_NEWSLETTER_NAME: process.env.CHANNEL_NEWSLETTER_NAME ||
        '🐾『 BLACK PANTHER MD 』🐾',

    // Compatibility with settings display
    NEWSLETTER_JID: process.env.NEWSLETTER_JID ||
        process.env.CHANNEL_JID ||
        '120363427012090993@newsletter',
    YT: process.env.YT || 'youtube.com/@lucvoice',

    // ── Connection ────────────────────────────────────
    SESSION_ID: process.env.SESSION_ID || '',

    // ── Mode & Behaviour ──────────────────────────────
    MODE: process.env.MODE || 'public',
    TIME_ZONE: process.env.TIME_ZONE || 'Africa/Nairobi',

    // ── Auto Features ────────────────────────────────
    AUTO_READ_STATUS: bool('AUTO_READ_STATUS', true),
    AUTO_READ_MESSAGES: process.env.AUTO_READ_MESSAGES || 'off',
    AUTO_LIKE_STATUS: bool('AUTO_LIKE_STATUS', true),
    AUTO_REACT: process.env.AUTO_REACT || 'off',
    AUTO_BIO: bool('AUTO_BIO', true),
    AUTO_TYPING: bool('AUTO_TYPING', false),
    AUTO_RECORDING: bool('AUTO_RECORDING', false),
    AUTO_CHANNEL_LIKE: bool('AUTO_CHANNEL_LIKE', true),
    AUTO_JOIN: bool('AUTO_JOIN', true),
    AUTO_MUTE: bool('AUTO_MUTE', false),
    AUTO_BLOCK: process.env.AUTO_BLOCK || 'Not Set',
    AUTO_REPLY: bool('AUTO_REPLY', false),
    AUTO_REPLY_STATUS: bool('AUTO_REPLY_STATUS', false),
    AUTO_UPDATE: bool('AUTO_UPDATE', true),
    STARTING_MESSAGE: bool('STARTING_MESSAGE', true),

    // ── Privacy / Protection ──────────────────────────
    ANTICALL: bool('ANTICALL', false),
    ANTICALL_MSG: process.env.ANTICALL_MSG ||
        '*📞 Auto Call Reject Mode Active. 📵 No calls are accepted.*',
    ANTIDELETE: process.env.ANTIDELETE || 'indm',
    ANTIVIEWONCE: process.env.ANTIVIEWONCE || 'indm',
    ANTI_EDIT: process.env.ANTI_EDIT || 'indm',
    ANTI_VV: bool('ANTI_VV', true),
    REJECT_CALL: bool('REJECT_CALL', false),
    TAG_PROTECT: bool('TAG_PROTECT', false),
    GLOBAL_SPAM_FILTER: bool('GLOBAL_SPAM_FILTER', false),
    PM_PERMIT: bool('PM_PERMIT', false),
    DM_PERMIT_ACTION: process.env.DM_PERMIT_ACTION || 'warn',
    DM_PERMIT_MSG: process.env.DM_PERMIT_MSG ||
        '⚠️ PM Permit Active! You are not allowed to message repeatedly.',
    DM_PRESENCE: process.env.DM_PRESENCE || 'online',
    GC_PRESENCE: process.env.GC_PRESENCE || 'online',
    CHATBOT: bool('CHATBOT', false),
    CHATBOT_MODE: process.env.CHATBOT_MODE || 'inbox',

    // ── Status Manager ────────────────────────────────
    AUTO_STATUS_SEEN: process.env.AUTO_STATUS_SEEN ||
        String(bool('AUTO_READ_STATUS', true)),
    AUTO_STATUS_REACT: process.env.AUTO_STATUS_REACT ||
        String(bool('AUTO_LIKE_STATUS', true)),
    AUTO_STATUS_MSG: process.env.AUTO_STATUS_MSG || '',
    Status_Saver: process.env.Status_Saver || 'false',
    Status_Saver_Owner_Notify: process.env.Status_Saver_Owner_Notify || 'false',
    STATUS_REPLY: bool('STATUS_REPLY', false),
    STATUS_MSG: process.env.STATUS_MSG || '',
    STATUS_REPLY_TEXT: process.env.STATUS_REPLY_TEXT ||
        '✨ Your status viewed successfully! ✨',
    STATUS_REACT_EMOJI: process.env.STATUS_REACT_EMOJI || 'Not Set',
    STATUS_LIKE_EMOJIS: process.env.STATUS_LIKE_EMOJIS ||
        '💚,💜,💙,❤️,💛,🦠',
    CUSTOM_REACT_EMOJIS: process.env.CUSTOM_REACT_EMOJIS ||
        '🪾,🌴,🪻,🌿,🌲,🌵,🍂,☄️,🪽,🪶,🚀,🍖',

    // ── Greetings ─────────────────────────────────────
    GREETINGS_AUTOTRACK: bool('GREETINGS_AUTOTRACK', true),
    GREETINGS_ENABLED: bool('GREETINGS_ENABLED', false),
    GREETINGS_GM_MSG: process.env.GREETINGS_GM_MSG || 'Not Set',
    GREETINGS_GM_TIME: process.env.GREETINGS_GM_TIME || '06:00',
    GREETINGS_GN_MSG: process.env.GREETINGS_GN_MSG || 'Not Set',
    GREETINGS_GN_TIME: process.env.GREETINGS_GN_TIME || '22:00',

    // ── Group / Newsletter ────────────────────────────
    GC_JID: process.env.GC_JID || '',
    GROUP_JOIN_ACTION: process.env.GROUP_JOIN_ACTION || 'join',
    AUTO_FOLLOW_CHANNEL: bool('AUTO_FOLLOW_CHANNEL', true),
    AUTO_JOIN_GROUPS: process.env.AUTO_JOIN_GROUPS || '',

    // ── Database ──────────────────────────────────────
    DATABASE_URL: process.env.DATABASE_URL || null,

    // ── Server ────────────────────────────────────────
    PORT: parseInt(process.env.PORT, 10) || 5000,

    // ── Warnings ──────────────────────────────────────
    WARN_COUNT: parseInt(process.env.WARN_COUNT, 10) || 3,
    WARN_LIMIT: parseInt(process.env.WARN_LIMIT, 10) || 3,
    MSG_COUNTER: parseInt(process.env.MSG_COUNTER, 10) || 0,

    // ── Sudo ──────────────────────────────────────────
    SUDO_NUMBERS: process.env.SUDO_NUMBERS || '',
    SUDO_USERS: process.env.SUDO_USERS || '',

    // ── Auto ViewOnce ─────────────────────────────────
    VV_TRACKER: bool('VV_TRACKER', true),

    // ── Licence Expiry ────────────────────────────────
    EXPIRY_DATE: process.env.EXPIRY_DATE || '',
};

module.exports = config;
