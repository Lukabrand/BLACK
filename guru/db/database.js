'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Heroku dyno storage is ephemeral. PostgreSQL is the durable source of truth
// for command settings; SQLite remains the synchronous local cache.
let pgPool = null;
let persistQueue = Promise.resolve();
let persistentReady = false;
let persistentError = null;

function queuePersistentWrite(task) {
    if (!pgPool) return;
    persistQueue = persistQueue.then(task).then(() => {
        persistentError = null;
    }).catch(err => {
        persistentError = err;
        console.error('[DB] PostgreSQL settings write failed:', err.message);
    });
}

async function flushPersistentWrites() {
    await persistQueue;
    if (pgPool && persistentError) throw persistentError;
}

const DB_DIR  = path.join(__dirname, '../GuruTech/sessions');
const DB_PATH = path.join(DB_DIR, 'panther.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size   = -8000');
db.pragma('temp_store   = MEMORY');
db.pragma('mmap_size    = 67108864');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sudo (
        jid      TEXT PRIMARY KEY,
        added_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_settings (
        jid          TEXT PRIMARY KEY,
        antilink     INTEGER DEFAULT 0,
        antispam     INTEGER DEFAULT 0,
        antibadword  INTEGER DEFAULT 0,
        anticall     INTEGER DEFAULT 0,
        welcome      INTEGER DEFAULT 0,
        goodbye      INTEGER DEFAULT 0,
        antidelete   INTEGER DEFAULT 0,
        mute         INTEGER DEFAULT 0,
        antimention  INTEGER DEFAULT 0,
        antiviewonce INTEGER DEFAULT 0,
        antiforeign  INTEGER DEFAULT 0,
        antisticker  INTEGER DEFAULT 0,
        antiflood    INTEGER DEFAULT 0,
        welcomeMsg   TEXT DEFAULT '',
        welcome_on   INTEGER DEFAULT 0,
        bye           TEXT DEFAULT '',
        bye_on        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS warnings (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        jid       TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        reason    TEXT,
        issued_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        name      TEXT NOT NULL,
        content   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cmd_stats (
        command    TEXT PRIMARY KEY,
        uses       INTEGER DEFAULT 0,
        last_used  TEXT DEFAULT (datetime('now'))
    );
`);

db.exec(`
    CREATE INDEX IF NOT EXISTS idx_warnings_jid_group ON warnings(jid, group_jid);
    CREATE INDEX IF NOT EXISTS idx_notes_group        ON notes(group_jid, name);
`);

const newCols = ['antimention', 'antiviewonce', 'antiforeign', 'antisticker', 'antiflood', 'antiedit', "welcomeMsg TEXT DEFAULT ''", 'welcome_on INTEGER DEFAULT 0', "bye TEXT DEFAULT ''", 'bye_on INTEGER DEFAULT 0'];
for (const col of newCols) {
    try { db.exec(`ALTER TABLE group_settings ADD COLUMN ${col}`); } catch {}
}

const stmts = {
    getSetting:        db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting:        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'),
    seedOne:           db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),
    addSudo:           db.prepare('INSERT OR IGNORE INTO sudo (jid) VALUES (?)'),
    removeSudo:        db.prepare('DELETE FROM sudo WHERE jid = ?'),
    getSudoList:       db.prepare('SELECT jid FROM sudo'),
    isSudo:            db.prepare('SELECT 1 FROM sudo WHERE jid = ?'),
    getGroupSettings:  db.prepare('SELECT * FROM group_settings WHERE jid = ?'),
    insertGroupRow:    db.prepare('INSERT OR IGNORE INTO group_settings (jid) VALUES (?)'),
    addWarning:        db.prepare('INSERT INTO warnings (jid, group_jid, reason) VALUES (?, ?, ?)'),
    countWarnings:     db.prepare('SELECT COUNT(*) as c FROM warnings WHERE jid = ? AND group_jid = ?'),
    clearWarnings:     db.prepare('DELETE FROM warnings WHERE jid = ? AND group_jid = ?'),
    allGroupWarnings:  db.prepare('SELECT jid, reason, issued_at FROM warnings WHERE group_jid = ? ORDER BY issued_at DESC'),
    saveNote:          db.prepare('INSERT OR REPLACE INTO notes (group_jid, name, content) VALUES (?, ?, ?)'),
    getNote:           db.prepare('SELECT * FROM notes WHERE group_jid = ? AND name = ?'),
    getAllNotes:        db.prepare('SELECT * FROM notes WHERE group_jid = ?'),
    deleteNote:        db.prepare('DELETE FROM notes WHERE group_jid = ? AND name = ?'),
    trackCmd:          db.prepare(`
        INSERT INTO cmd_stats (command, uses, last_used)
        VALUES (?, 1, datetime('now'))
        ON CONFLICT(command) DO UPDATE SET
            uses      = uses + 1,
            last_used = datetime('now')
    `),
    getTopCmds:        db.prepare('SELECT command, uses, last_used FROM cmd_stats ORDER BY uses DESC LIMIT ?'),
    getCmdStat:        db.prepare('SELECT uses, last_used FROM cmd_stats WHERE command = ?'),
    getTotalUses:      db.prepare('SELECT SUM(uses) as total FROM cmd_stats'),
    resetCmdStats:     db.prepare('DELETE FROM cmd_stats'),
};

const groupSettingStmtCache = new Map();

function getSetting(key, fallback = null) {
    const row = stmts.getSetting.get(key);
    return row ? row.value : fallback;
}

function setSetting(key, value) {
    const normalized = String(value);
    stmts.setSetting.run(key, normalized);
    queuePersistentWrite(() => pgPool.query(
        `INSERT INTO bot_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(key), normalized]
    ));
}

function seedDefaults(defaults = {}) {
    const many = db.transaction((rows) => {
        for (const [k, v] of rows) stmts.seedOne.run(k, String(v));
    });
    many(Object.entries(defaults));
}

function addSudo(jid)    { stmts.addSudo.run(jid); }
function removeSudo(jid) { stmts.removeSudo.run(jid); }
function getSudoList()   { return stmts.getSudoList.all().map(r => r.jid); }
function isSudo(jid)     { return !!stmts.isSudo.get(jid); }

function getGroupSettings(jid) {
    let row = stmts.getGroupSettings.get(jid);
    if (!row) {
        stmts.insertGroupRow.run(jid);
        row = stmts.getGroupSettings.get(jid);
    }
    return row;
}

function setGroupSetting(jid, key, value) {
    const columns = new Set(db.prepare('PRAGMA table_info(group_settings)').all().map(c => c.name));
    if (!columns.has(key)) throw new Error(`Unknown group setting: ${key}`);
    if (!groupSettingStmtCache.has(key)) {
        groupSettingStmtCache.set(key, db.prepare(`UPDATE group_settings SET ${key} = ? WHERE jid = ?`));
    }
    stmts.insertGroupRow.run(jid);
    const storedValue = ['welcomeMsg', 'bye'].includes(key) ? String(value ?? '') : (value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1' ? 1 : 0);
    groupSettingStmtCache.get(key).run(storedValue, jid);
    const row = stmts.getGroupSettings.get(jid);
    queuePersistentWrite(() => pgPool.query(
        `INSERT INTO bot_group_settings (jid, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (jid) DO UPDATE SET data = EXCLUDED.data`,
        [String(jid), JSON.stringify(row)]
    ));
}

function addWarning(jid, groupJid, reason = '') {
    stmts.addWarning.run(jid, groupJid, reason);
    return stmts.countWarnings.get(jid, groupJid).c;
}
function getWarnings(jid, groupJid) {
    return stmts.countWarnings.get(jid, groupJid).c;
}
function getAllWarnings(groupJid) {
    return stmts.allGroupWarnings.all(groupJid);
}
function clearWarnings(jid, groupJid) {
    stmts.clearWarnings.run(jid, groupJid);
}

function saveNote(groupJid, name, content) {
    stmts.saveNote.run(groupJid, name, content);
}
function getNote(groupJid, name) {
    return stmts.getNote.get(groupJid, name);
}
function getAllNotes(groupJid) {
    return stmts.getAllNotes.all(groupJid);
}
function deleteNote(groupJid, name) {
    stmts.deleteNote.run(groupJid, name);
}

function trackCmd(command)          { try { stmts.trackCmd.run(command); } catch {} }
function getTopCmds(limit = 10)    { return stmts.getTopCmds.all(limit); }
function getCmdStat(command)       { return stmts.getCmdStat.get(command); }
function getTotalUses()            { return stmts.getTotalUses.get()?.total || 0; }
function resetCmdStats()           { stmts.resetCmdStats.run(); }

function getConfigSync(key, defaultValue = {}) {
    const row = stmts.getSetting.get(key);
    if (!row) return { ...defaultValue };
    try { return JSON.parse(row.value); } catch { return { ...defaultValue }; }
}

async function setConfig(key, value) {
    const normalized = JSON.stringify(value);
    stmts.setSetting.run(key, normalized);
    queuePersistentWrite(() => pgPool.query(
        `INSERT INTO bot_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(key), normalized]
    ));
}

async function initPersistentSettings() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.warn('[DB] DATABASE_URL is missing. Settings use local SQLite and may reset when the Heroku dyno restarts.');
        return { persistent: false, reason: 'DATABASE_URL missing' };
    }

    let Pool;
    try { ({ Pool } = require('pg')); }
    catch (error) {
        console.error('[DB] PostgreSQL driver is not installed:', error.message);
        return { persistent: false, reason: 'pg package missing' };
    }

    pgPool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS bot_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_group_settings (
            jid TEXT PRIMARY KEY,
            data JSONB NOT NULL DEFAULT '{}'::jsonb
        );
    `);

    // One-time migration: copy existing SQLite values without overwriting
    // settings already saved in PostgreSQL.
    const localSettings = db.prepare('SELECT key, value FROM settings').all();
    for (const row of localSettings) {
        await pgPool.query(
            'INSERT INTO bot_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [row.key, row.value]
        );
    }

    const localGroups = db.prepare('SELECT * FROM group_settings').all();
    for (const row of localGroups) {
        await pgPool.query(
            'INSERT INTO bot_group_settings (jid, data) VALUES ($1, $2::jsonb) ON CONFLICT (jid) DO NOTHING',
            [row.jid, JSON.stringify(row)]
        );
    }

    // Load durable values into the synchronous SQLite cache before plugins
    // are loaded and before the WhatsApp socket starts.
    const remoteSettings = await pgPool.query('SELECT key, value FROM bot_settings');
    const saveLocalSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const saveManySettings = db.transaction(rows => {
        for (const row of rows) saveLocalSetting.run(row.key, row.value);
    });
    saveManySettings(remoteSettings.rows);

    const remoteGroups = await pgPool.query('SELECT jid, data FROM bot_group_settings');
    const columns = new Set(db.prepare('PRAGMA table_info(group_settings)').all().map(c => c.name));
    const validColumns = [...columns].filter(c => c !== 'jid');
    const updateGroup = db.prepare(`UPDATE group_settings SET ${validColumns.map(c => `${c} = @${c}`).join(', ')} WHERE jid = @jid`);
    const insertGroup = db.prepare('INSERT OR IGNORE INTO group_settings (jid) VALUES (?)');
    const saveGroups = db.transaction(rows => {
        for (const item of rows) {
            const data = typeof item.data === 'string' ? JSON.parse(item.data) : (item.data || {});
            insertGroup.run(item.jid);
            const values = { jid: item.jid };
            for (const col of validColumns) {
                values[col] = Object.prototype.hasOwnProperty.call(data, col)
                    ? data[col]
                    : (['welcomeMsg', 'bye'].includes(col) ? '' : 0);
            }
            updateGroup.run(values);
        }
    });
    saveGroups(remoteGroups.rows);

    persistentReady = true;
    persistentError = null;
    console.log(`[DB] PostgreSQL persistence ready (${remoteSettings.rowCount} global settings, ${remoteGroups.rowCount} group settings).`);
    return { persistent: true, settings: remoteSettings.rowCount, groups: remoteGroups.rowCount };
}

function checkpoint() {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
}
process.on('exit', checkpoint);
let shuttingDown = false;
async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await flushPersistentWrites(); } catch (err) { console.error('[DB] Final persistence flush failed:', err.message); }
    try {
        const jsonDb = await import('../../guruh/database/config.js');
        await jsonDb.flushPersistentDatabase();
    } catch (err) { console.error('[DB] JSON database final flush failed:', err.message); }
    checkpoint();
    if (pgPool) { try { await pgPool.end(); } catch {} }
    process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = {
    db,
    initPersistentSettings, flushPersistentWrites,
    getSetting, setSetting, seedDefaults,
    getConfigSync, setConfig,
    addSudo, removeSudo, getSudoList, isSudo,
    getGroupSettings, setGroupSetting,
    addWarning, getWarnings, getAllWarnings, clearWarnings,
    saveNote, getNote, getAllNotes, deleteNote,
    trackCmd, getTopCmds, getCmdStat, getTotalUses, resetCmdStats,
};
