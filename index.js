const { default: makeWASocket, useMultiFileAuthState, jidDecode, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');
const sharp = require('sharp');

// ── Structured file logger ──
const logStream = pino.destination(path.join(__dirname, 'bot.log'), { sync: false });
const logger = pino(logStream);

// ── Crash-proofing ──
// Transient network errors (e.g. ECONNRESET on an image fetch) can emit an
// 'error' event on the underlying stream that escapes normal try/catch and
// kills the whole process. Swallow these at the top level so the bot keeps running.
process.on('uncaughtException', (err) => {
    logger.error({ err }, '[UNCAUGHT]');
});
process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, '[UNHANDLED_REJECTION]');
});

// Graceful shutdown: save database before exiting
async function gracefulShutdown(signal) {
    logger.info(`[SHUTDOWN] Received ${signal}, saving database...`);
    try {
        saveDb();
        logger.info('[SHUTDOWN] Database saved successfully.');
    } catch (e) {
        logger.error({ err: e }, '[SHUTDOWN] Failed to save database');
    }
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const PREFIX = '.';
const sessionsDir = path.join(__dirname, 'sessions');
const dbDir = path.join(__dirname, 'database');

if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Each device gets its own auth session folder under sessions/<id>.
// Legacy single-session layout (sessions/creds.json) is treated as device "main".
function getSessionDir(id) {
    const dir = path.join(sessionsDir, id);
    if (id === 'main' && !fs.existsSync(dir) && fs.existsSync(path.join(sessionsDir, 'creds.json'))) {
        return sessionsDir;
    }
    return dir;
}

const dbPath = path.join(dbDir, 'jjkbot.json');
let db = { enabledGroups: {}, users: {}, combats: {}, world: {}, shops: {}, soldSummons: {}, activeQuest: null, scatteredFingers: 0, pvp: {}, villages: {}, darkContinent: { active: false, regions: {}, shards: [], pandoraBox: { locked: true, keyFound: false, kingsUnleashed: false, gojoEncountered: false } }, userSkills: {} };

if (fs.existsSync(dbPath)) {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}
if (!db._bootTime) db._bootTime = Date.now();
if (!db._firstBloodWinner) db._firstBloodWinner = null;
db.pvp = db.pvp || {};

// One-time migration: enforce the one-summon rule on legacy data.
// Any user holding more than one summon gets ALL of them returned to the shop for sale.
if (!db._singleSummonCleanup) {
    db.soldSummons = db.soldSummons || {};
    let cleaned = 0;
    for (const u of Object.values(db.users || {})) {
        if (Array.isArray(u.ownedSummons) && u.ownedSummons.length > 1) {
            for (const oid of u.ownedSummons) {
                if (db.soldSummons[oid] === (u.player_id || u)) delete db.soldSummons[oid];
            }
            u.ownedSummons = [];
            u.summon = { active: false, name: 'None', HP: 0, Max_HP: 0, type: 'None' };
            cleaned++;
        }
    }
    if (cleaned) saveDb();
    db._singleSummonCleanup = true;
}
function saveDb() {
    try {
        const tmpPath = dbPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
        fs.renameSync(tmpPath, dbPath);
    } catch (err) {
        console.error('Failed to save database:', err);
    }
}

const modPath = path.join(dbDir, 'mod.json');
let mods = [];
if (fs.existsSync(modPath)) {
    mods = JSON.parse(fs.readFileSync(modPath, 'utf8')).mods || [];
}
function saveMods() { fs.writeFileSync(modPath, JSON.stringify({ mods }, null, 2)); }

// ── Security layer ──
// Compares JIDs by their numeric part so @s.whatsapp.net vs @lid etc. don't mismatch.
function jidNum(jid) { return (jid || '').replace(/[^0-9]/g, ''); }
function sameJid(a, b) { const x = jidNum(a), y = jidNum(b); return x.length > 0 && x === y; }
function jidInArray(jid, arr) {
    if (!arr || !Array.isArray(arr)) return false;
    return arr.some(item => sameJid(item, jid));
}
function addJidToArray(jid, arr) {
    if (!Array.isArray(arr)) return arr;
    if (!jidInArray(jid, arr)) arr.push(jid);
    return arr;
}
function removeJidFromArray(jid, arr) {
    if (!arr || !Array.isArray(arr)) return arr;
    return arr.filter(item => !sameJid(item, jid));
}
function findUserByJid(jid) {
    if (!jid) return null;
    const num = jidNum(jid);
    if (!num) return null;
    // Direct match first
    if (db.users[jid]) return db.users[jid];
    // Fallback: search by numeric part
    for (const u of Object.values(db.users)) {
        if (sameJid(u.player_id, jid) || sameJid(u.name, jid)) return u;
    }
    return null;
}
function parseSafeInt(val, min = 1, max = 1000000) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < min || n > max) return null;
    return n;
}

const configPath = path.join(dbDir, 'config.json');
let config = { owner: process.env.OWNER || null, banned: [], devices: {}, antiBan: { enabled: true, globalMinIntervalMs: 500, jidMinIntervalMs: 900, perMinuteCap: 30, maxQueue: 80, jitterMs: 250 } };
if (fs.existsSync(configPath)) {
    try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }; } catch {}
}
function saveConfig() { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); }

const BACKUP_DIR = path.join(__dirname, 'backups');
function createBackup() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `backup-${ts}`);
    fs.mkdirSync(dest, { recursive: true });
    const files = ['jjkbot.json', 'mod.json', 'config.json', 'curse.json', 'user.json'];
    for (const f of files) {
        const src = path.join(dbDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    const avatarsDir = path.join(dbDir, 'avatars');
    if (fs.existsSync(avatarsDir)) {
        fs.cpSync(avatarsDir, path.join(dest, 'avatars'), { recursive: true });
    }
    // Prune old backups (keep last 24)
    const entries = fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup-')).sort().reverse();
    for (let i = 24; i < entries.length; i++) {
        const old = path.join(BACKUP_DIR, entries[i]);
        try { fs.rmSync(old, { recursive: true, force: true }); } catch {}
    }
    console.log(`[backup] Created ${dest} (kept ${Math.min(entries.length, 24)} backups)`);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
createBackup();
setInterval(createBackup, 60 * 60 * 1000);

// Latest active socket / bot identity, used for out-of-handler broadcasts and self-message filtering.
let BOT_SOCK = null;
let BOT_JID = null;
function broadcastNow(text) { if (BOT_SOCK) broadcastAllGroups(BOT_SOCK, text); }

// Owner is the trusted operator (set via OWNER env or config.json). Used to gate privilege commands.
function isOwner(sender) { return !!config.owner && sameJid(sender, config.owner); }
function isMod(sender) { return mods.some(m => sameJid(m, sender)); }
function isBanned(sender) { return config.banned.some(b => sameJid(b, sender)); }
function banUser(sender, reason) {
    const key = sender;
    if (!config.banned.some(b => sameJid(b, key))) config.banned.push(key);
    saveConfig();
    if (db.users[sender]) delete db.users[sender];
    if (db.combats[sender]) delete db.combats[sender];
}

// Runtime intrusion tracking (not persisted). sender -> { susp, msgs:[ts], attempts:{} }
const intrusion = {};
const lastCmdAt = new Map();
function recIntrusion(sender, type, weight = 1) {
    const t = intrusion[sender] = intrusion[sender] || { susp: 0, msgs: [], attempts: {} };
    t.attempts[type] = (t.attempts[type] || 0) + 1;
    t.susp += weight;
    return t;
}
function recMessage(sender) {
    const t = intrusion[sender] = intrusion[sender] || { susp: 0, msgs: [], attempts: {} };
    const now = Date.now();
    t.msgs = (t.msgs || []).filter(x => now - x < 5000);
    t.msgs.push(now);
    return t.msgs.length;
}

async function kickOff(sock, from, sender, reason) {
    banUser(sender, reason);
    try { await sock.sendMessage(from, { text: `🚫 *ACCESS REVOKED*\nReason: ${reason}.\nThis number has been permanently blocked from KENNYJAKS and its data wiped.`, mentions: [sender] }); } catch {}
    if (from.endsWith('@g.us')) {
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); } catch {}
    }
    console.log(`[SECURITY] Banned & kicked ${sender} — ${reason}`);
}

const cursePath = path.join(dbDir, 'curse.json');
let CURSES = [];
    if (fs.existsSync(cursePath)) {
        CURSES = JSON.parse(fs.readFileSync(cursePath, 'utf8'));
    }
    ensureFingerState();
function getRandomCurse() {
    const specialGrade = CURSES.filter(c => c.grade === 'Special Grade');
    const grade1 = CURSES.filter(c => c.grade === 'Grade 1');
    const grade2 = CURSES.filter(c => c.grade === 'Grade 2');
    const grade3 = CURSES.filter(c => c.grade === 'Grade 3');
    const grade4 = CURSES.filter(c => c.grade === 'Grade 4');
    const strong = [...specialGrade, ...grade1, ...grade2];
    const mid = [...grade3];
    const weak = [...grade4];
    const roll = Math.random();
    let pool = weak;
    if (roll < 0.23 && strong.length) pool = strong;
    else if (roll < 0.45 && mid.length) pool = mid;
    else if (weak.length === 0) pool = CURSES;
    return pool[Math.floor(Math.random() * pool.length)];
}

const INNATE_TECHNIQUES = {
    'Necrotic Overgrowth': { type: 'Curse', moves: { necrotic_touch: { cost: 10, damage: 15, effect: 'ROT', dot: 5, turns: 3 }, spore_bloom: { cost: 20, damage: 25, area: true }, rooted_decay: { cost: 15, effect: 'IMMOBILIZED', turns: 1 }, max_gangrene: { cost: 50, damage: 70, armor_piercing: true } } },
    'Chitinous Arsenal': { type: 'Curse', moves: { molt_shrapnel: { cost: 15, damage: 20, pierce: true }, exoskeleton_aegis: { cost: 15, effect: 'ARMOR', block: 40, turns: 2 }, bone_thrust: { cost: 10, damage: 25 }, molting_regen: { cost: 30, heal: 40, defense_drop: 0.2, turns: 1 } } },
    'Parasitic Mimicry': { type: 'Curse', moves: { flesh_needle: { cost: 10, damage: 5 }, echo_sync: { cost: 15, reveal_next: true }, siphon_drain: { cost: 20, steal_ce: 25 }, puppet_fracture: { cost: 25, effect: 'SKIP_TURN' } } },
    'Liquefaction': { type: 'Curse', moves: { puddle_evade: { cost: 20, effect: 'DODGE_NEXT' }, acid_melt: { cost: 15, damage: 20, debuff_armor: 0.15 }, sludge_suffocate: { cost: 25, damage: 20, damage_per_turn: 20, effect: 'BLINDED', turns: 2 }, hydro_jet: { cost: 35, damage: 45, structural: true } } },
    'Amorphous Grafting': { type: 'Curse', moves: { stray_stitch: { cost: 15, buff: 'STRIKE_DAMAGE', value: 5 }, chimera_strike: { cost: 20, damage: 35 }, trait_plunder: { cost: 25, effect: 'COPY_TRAIT', turns: 3 }, flesh_reject: { cost: 30, damage: 40, area: true } } },
    'Miasma Exhalation': { type: 'Curse', moves: { suffocating_veil: { cost: 15, debuff_accuracy: 30 }, corrosive_breath: { cost: 20, damage: 25, effect: 'BLINDED', turns: 1 }, nerve_pulse: { cost: 25, debuff_ce_cost: 5 }, max_pestilence: { cost: 55, damage: 30, damage_per_turn: 30, area: true, turns: 3 } } },
    'Paranoia Echo': { type: 'Curse', moves: { whisper_distract: { cost: 10, effect: 'FAIL_LOW_ROLL' }, doubt_spike: { cost: 15, debuff_damage: 0.5 }, feedback_loop: { cost: 25, damage_self: 20 }, phantom_crowd: { cost: 30, effect: 'GUESS_TARGET' } } },
    'Sensory Deprivation Void': { type: 'Curse', moves: { blinded_gaze: { cost: 20, effect: 'BLINDED', turns: 2 }, deafening_silence: { cost: 15, effect: 'NO_BUFFS' }, numb_touch: { cost: 20, effect: 'MISSFIRE' }, sensory_overload: { cost: 35, effect: 'STUN', turns: 1 } } },
    'Vertigo Distortion': { type: 'Curse', moves: { inverted_fall: { cost: 15, debuff_evasion: true }, shadow_pit: { cost: 20, debuff_accuracy: true }, nausea_pulse: { cost: 20, damage: 15, debuff_output: true }, horizon_tilt: { cost: 30, effect: 'MISS_NEXT' } } },
    'Tectonic Tremor': { type: 'Curse', moves: { fault_snap: { cost: 15, damage: 20, impact: true }, liquefaction_bog: { cost: 20, damage: 10, trap: true }, seismic_pulse: { cost: 15, knock_prone: true }, rock_shield: { cost: 25, block: 40, damage_type: 'physical' } } },
    'Ash Cloud Suffocation': { type: 'Curse', moves: { cinder_screen: { cost: 15, debuff_accuracy: 40 }, oxygen_starvation: { cost: 25, damage_per_turn: 15 }, superheat_burst: { cost: 30, damage: 35, area: true }, ash_mimic: { cost: 20, decoy: true } } },
    'Abyssal Pressure': { type: 'Curse', moves: { gravity_drop: { cost: 20, debuff_ce: 2 }, pressure_bubble: { cost: 20, destroy_projectiles: true }, implosion_touch: { cost: 30, damage: 35, structural: true }, max_mariana: { cost: 60, damage: 60, flat: true } } },
    'Decay Radiation': { type: 'Curse', moves: { structural_crumble: { cost: 15, damage: 20, environmental: true }, weapon_rust: { cost: 20, debuff_weapon: 0.5 }, barrier_decay: { cost: 30, damage_barriers: 3, structural: true }, marrow_rot: { cost: 35, debuff_max_hp: 5, per_turn: true } } },
    'Glacial Frostbite': { type: 'Curse', moves: { black_ice_path: { cost: 15, prevent_closing: true }, frostbite_spike: { cost: 15, damage: 20, pierce: true, frost: true }, channel_freeze: { cost: 30, lock_ce: 20, turns: 3 }, ice_coffin: { cost: 35, effect: 'STUN', turns: 1 } } },
    'Static Combustion': { type: 'Curse', moves: { friction_charge: { cost: 0, passive_tokens: 2 }, spark_snap: { cost: 15, damage_per_token: 10 }, combustion_trail: { cost: 20, damage: 30, trap: true }, discharge_strike: { cost: 35, damage: 50 } } },
    'Energy Inversion': { type: 'Curse', moves: { joy_ruin: { cost: 15, debuff_output: 0.3 }, rct_disrupt: { cost: 35, reflect_rct: true }, malice_flip: { cost: 20, convert_hp_to_damage: true }, emotional_drain: { cost: 25, no_critical: true } } },
    'Soul Siphon': { type: 'Curse', moves: { residual_feast: { cost: 10, heal: 15 }, vampiric_grapple: { cost: 25, steal_hp: 20, steal_ce: 20 }, spiritual_scavenge: { cost: 30, buff_max_ce: 10 }, siphon_shield: { cost: 25, block: 30 } } },
    'Shadow Swarm': { type: 'Curse', moves: { swarm_shield: { cost: 15, block_micro: true }, blinding_cloud: { cost: 20, effect: 'MISS' }, shadow_anchor: { cost: 25, prevent_dodge: true }, hive_detonation: { cost: 35, damage: 40, area: true } } },
    'Contractual Bind': { type: 'Curse', moves: { vow_bait: { cost: 10, recoil_risk: 20 }, trifling_tax: { cost: 20, rule_violation_damage: 30 }, stipulation_shield: { cost: 25, invulnerable: true, turns: 1 }, forfeiture_snap: { cost: 35, paralyze: 1 } } },
    'Malice Conduit': { type: 'Curse', moves: { taunt_surge: { cost: 10, output_buff_per_hit: 10 }, fear_feed: { cost: 15, speed_buff_if_target_low: 25 }, hatred_armor: { cost: 25, block: 35 }, max_monolithic: { cost: 60, damage: 65, transform: true } } },
    'False Domain': { type: 'Curse', moves: { barrier_trick: { cost: 20, bait_defensive: true }, aesthetic_shift: { cost: 15, debuff_accuracy: 20 }, sure_hit_bluff: { cost: 25, force_simple_domain: true, cost_target: 30 }, shatter_escape: { cost: 30, escape_combat: true } } },
    'Thread of Fate': { type: 'Curse', moves: { fate_needle: { cost: 15, apply_thread: true }, sympathetic_pain: { cost: 20, self_damage: 15, target_damage: 30, require_thread: true }, tether_pull: { cost: 15, pull_to_melee: true }, thread_sever: { cost: 30, damage: 35 } } },
    'Spatial Tear': { type: 'Curse', moves: { bite_void: { cost: 20, swallow_projectile: true }, rift_step: { cost: 25, teleport_behind: true }, spatial_sever: { cost: 35, damage: 40, unblockable: true }, portal_mirror: { cost: 35, reflect_attack: true } } },
    'Echoing Scream': { type: 'Curse', moves: { sonic_stun: { cost: 15, reduce_priority: true }, resonance_shatter: { cost: 20, damage: 25, environmental: true }, amplified_reverb: { cost: 30, damage: 40, double: true }, max_banshee: { cost: 55, damage: 50, area: true } } },
    'Kinetic Absorption': { type: 'Curse', moves: { brace_impact: { cost: 15, absorb_damage: true }, stored_release: { cost: 20, discharge_stored: true }, kinetic_brake: { cost: 20, cancel_charge: true }, shockwave_stomp: { cost: 30, damage: 30, area: true } } },
    'Puppeteers Regret': { type: 'Curse', moves: { corpse_awaken: { cost: 15, summon: 'MeatShield', hp: 20 }, suicide_bomber: { cost: 25, damage: 35, area: true }, meat_wall: { cost: 30, block: 50 }, blood_link: { cost: 35, damage: 40 } } },
    'Void Pocket': { type: 'Curse', moves: { abyssal_maw: { cost: 15, swallow_projectiles: true }, arsenal_drop: { cost: 25, damage: 35, area: true }, trap_capture: { cost: 30, remove_entity: true, turns: 2 }, void_shield: { cost: 25, block_physical: true } } },
    'Vector Alignment': { type: 'Fighter', moves: { linear_correction: { cost: 15, push_back: true }, deflective_path: { cost: 20, deflect_projectiles: true }, ricochet_cascade: { cost: 25, damage: 30, pierce: true }, max_trajectory: { cost: 55, pull_to_explosion: true, damage: 50 } } },
    'Geometric Horizon': { type: 'Fighter', moves: { grid_swap: { cost: 15, teleport_swap: true }, intercept_cross: { cost: 20, swap_enemy: true }, axis_tilt: { cost: 20, run_away: true }, grid_lock: { cost: 30, root_two_targets: true } } },
    'Ratio Fracture': { type: 'Fighter', moves: { ratio_strike: { cost: 15, damage: 30, critical: true }, fractured_guard: { cost: 20, break_defense: true }, focal_piercing: { cost: 25, break_domains: true }, collapse_point: { cost: 40, damage: 45, structural: true } } },
    'Momentum Storage': { type: 'Fighter', moves: { inertial_brake: { cost: 15, store_kinetic: true, stored_ce: 20 }, kinetic_release: { cost: 20, discharge_stored: true, damage: 35 }, air_stride: { cost: 15, stand_on_air: true }, delayed_impact: { cost: 30, delayed_damage: 30 } } },
    'Absolute Friction': { type: 'Fighter', moves: { zero_traction: { cost: 15, slip_target: true }, adhesive_anchor: { cost: 10, immune_knockback: true }, friction_burn: { cost: 25, damage: 25, burn: true }, grip_assist: { cost: 15, unbreakable_grip: true } } },
    'Spatial Compression': { type: 'Fighter', moves: { fold_snap: { cost: 20, teleport: true, damage: 25 }, compressed_shield: { cost: 25, slow_projectiles: true }, pocket_leap: { cost: 20, teleport_backward: true }, horizon_pinch: { cost: 30, pull_item: true } } },
    'Inkwell Calligraphy': { type: 'Fighter', moves: { kanji_shield: { cost: 15, block: 35 }, kanji_heavy: { cost: 20, debuff_speed: 0.5, turns: 2 }, kanji_burst: { cost: 25, damage: 35 }, max_scroll: { cost: 60, damage: 50, area: true } } },
    'Origami Army': { type: 'Fighter', moves: { crane_scout: { cost: 10, reveal_stealth: true }, needle_swarm: { cost: 20, damage: 25 }, goliath_toad: { cost: 30, summon: 'Toad', hp: 35, damage: 35 }, paper_shift: { cost: 25, dodge_attack: true } } },
    'Cinematic Frame': { type: 'Fighter', moves: { frame_drop: { cost: 20, evasion_buff: 30 }, stutter_touch: { cost: 25, frame_penalty: true }, freeze_frame: { cost: 30, freeze_target: true }, montage_speed: { cost: 40, multi_hit: 3, damage: 45 } } },
    'Symphony Conductor': { type: 'Fighter', moves: { crescendo_blast: { cost: 20, damage: 25 }, staccato_pulse: { cost: 15, debuff_accuracy: 25 }, resonance_wall: { cost: 25, deflect_bullets: true }, dissonant_chord: { cost: 30, tech_lock: 1 } } },
    'Thread Needle Weaver': { type: 'Fighter', moves: { suture_bind: { cost: 15, trap_target: true }, thread_tether: { cost: 15, cancel_action: true }, stitch_repair: { cost: 25, heal: 30 }, grid_net: { cost: 30, damage: 35 } } },
    'Snapshot Imprisonment': { type: 'Fighter', moves: { capture_frame: { cost: 20, seal_projectile: true }, flash_release: { cost: 10, reflect_sealed: true }, static_delay: { cost: 25, freeze_target: true, turns: 2 }, negative_inverse: { cost: 30, damage: 35 } } },
    'Synesthesia': { type: 'Fighter', moves: { aura_sight: { cost: 15, reveal_hidden: true }, pitch_tracking: { cost: 20, predict_move: true }, sensory_reroute: { cost: 20, dodge_blind: true }, shatter_tone: { cost: 35, destroy_weapon: true } } },
    'Tacticians Blueprint': { type: 'Fighter', moves: { sonar_pulse: { cost: 15, reveal_traps: true }, target_lock: { cost: 15, track_through_cover: true }, terrain_hazard: { cost: 25, damage: 30, environmental: true }, flaw_exploit: { cost: 20, evade_next_turn: true } } },
    'Fault Line Perception': { type: 'Fighter', moves: { structural_break: { cost: 20, ignore_defense: true }, stress_strike: { cost: 20, damage: 35 }, barrier_fracture: { cost: 30, break_barriers: true }, flaw_exploit: { cost: 25, ally_buff: 1.5 } } },
    'Analytical Counter': { type: 'Fighter', moves: { pattern_study: { cost: 15, evasion_buff: true }, adaptation_barrier: { cost: 25, resist_element: 40 }, counter_timing: { cost: 30, undodgeable: true }, technique_scramble: { cost: 35, fail_next_move: true } } },
    'Placebo Effect': { type: 'Fighter', moves: { phantom_blade: { cost: 15, damage: 20 }, false_venom: { cost: 25, dizzy: true }, mimic_impact: { cost: 25, damage: 25 }, placebo_shield: { cost: 20, feint_stop: true } } },
    'Focus Lock': { type: 'Fighter', moves: { time_dilation: { cost: 15, map_evasion: true }, instant_reflex: { cost: 20, parry_counter: true }, trajectory_plot: { cost: 25, dodge_projectiles: true }, mind_clear: { cost: 15, remove_debuffs: true } } },
    'Overtime Pay': { type: 'Fighter', moves: { restrained_output: { cost: 0, lock_output: 0.8, turns: 3 }, shift_clock: { cost: 0, output_buff: 1.2, turn: 4 }, bonus_strike: { cost: 30, damage: 45 }, endurance_drive: { cost: 25, remove_exhaustion: true } } },
    'Equal Exchange': { type: 'Fighter', moves: { pain_ledger: { cost: 15, store_damage: true }, reciprocal_edge: { cost: 20, reflect_stored: true }, fatigue_shift: { cost: 25, transfer_fatigue: true }, redemption_blow: { cost: 45, damage: 60, all_damage: true } } },
    'Tag Youre It': { type: 'Fighter', moves: { touch_trigger: { cost: 15, mark_target: true }, drain_cascade: { cost: 20, steal_ce: 10 }, sprint_advantage: { cost: 15, speed_boost: true }, tag_transfer: { cost: 25, transfer_mark: true } } },
    'Verbal Contract': { type: 'Fighter', moves: { inquiry_lock: { cost: 15, contract_seal: true }, prohibition_rule: { cost: 25, rule_damage: 35 }, truth_bind: { cost: 20, no_feints: true }, contract_nullify: { cost: 30, blind_target: true } } },
    'Debt Collector': { type: 'Fighter', moves: { parry_accumulation: { cost: 10, add_token: true }, massive_interest: { cost: 20, damage_per_token: 15 }, collateral_claim: { cost: 30, disarm_target: true }, default_crush: { cost: 40, damage: 50 } } },
    'Countdown Curse': { type: 'Fighter', moves: { mark_contact: { cost: 15, countdown: 3 }, tick_stutter: { cost: 10, tick_damage: 10 }, zero_hour: { cost: 35, explode_damage: 50 }, interval_reset: { cost: 20, reset_to_3: true } } },
    'Nervous System Overdrive': { type: 'Fighter', moves: { bio_flash: { cost: 20, dodge_any: true }, synapse_burst: { cost: 20, multi_parry: true }, overclock_punch: { cost: 25, damage: 25, numb: true }, max_neuro_collapse: { cost: 60, multi_action: true } } },
    'Pulse Calibration': { type: 'Fighter', moves: { rhythm_match: { cost: 15 }, phase_strike: { cost: 30, damage: 35 }, vessel_disrupt: { cost: 25, lose_slot: true }, harmonic_shield: { cost: 30, neutralize_element: true } } },
    'Mirror Coat': { type: 'Fighter', moves: { sheen_guard: { cost: 20 }, refractive_deflect: { cost: 25, reflect_attack: true }, glare_flash: { cost: 15, blind_enemies: true }, prism_dispersion: { cost: 35, scatter_aoe: true } } },
    'Weight Accumulation': { type: 'Fighter', moves: { heavy_gavel: { cost: 15, damage: 30 }, anchor_drop: { cost: 20, damage: 40 }, light_step: { cost: 10, walk_water: true }, momentum_anchor: { cost: 30, damage: 35 } } },
    'Cursed Energy Coating': { type: 'Fighter', moves: { monofilament_edge: { cost: 20, damage: 30, bleed: true }, shearing_swipe: { cost: 20 }, reinforced_core: { cost: 15, weapon_protection: true }, edge_extension: { cost: 25, extended_range: true } } },
    'Phantom Limb': { type: 'Fighter', moves: { concealed_reach: { cost: 15, damage: 20 }, grapple_extended: { cost: 20, pull_target: true }, quad_guard: { cost: 25, block_buff: 40 }, phantom_flurry: { cost: 40, damage: 45 } } },
    'Heavenly Restriction': { type: 'Fighter', moves: { heavy_slash: { name: 'Heavy Slash', cost: 20, damage: 156 }, clap_smash: { name: 'Clap Smash', cost: 15, damage: 76 }, super_fast_slash: { name: 'Super Fast Slash', cost: 25, damage: 45, speed_buff: 0.45, uses_heavy_slash: true }, divine_axe_slash: { name: 'Divine Axe Slash', cost: 80, damage: 500, hp_threshold: 10 }, ricochet_throw: { name: 'Ricochet Throw', cost: 30, damage: 140, pierce: true, pull_target: true }, parry_counter: { name: 'Parry & Counter Stance', cost: 20, damage: 120, parry_next: true, counter_damage: true } } },
    'Limitless': { type: 'Fighter', moves: { blue: { name: 'Cursed Technique Lapse: Blue', cost: 40, damage: 300, effect: 'pull' }, red: { name: 'Cursed Technique Reversal: Red', cost: 50, damage: 400, effect: 'repel' }, purple: { name: 'Hollow Technique: Purple', cost: 80, damage: 800, effect: 'erase' } } }
};

const CURSE_NAMES = Object.keys(INNATE_TECHNIQUES).filter(t => INNATE_TECHNIQUES[t].type === 'Curse');
const FIGHTER_NAMES = Object.keys(INNATE_TECHNIQUES).filter(t => INNATE_TECHNIQUES[t].type === 'Fighter');

const TOKYO_MAP = {
    'Tokyo Jujutsu High Hub': { danger: 1, connections: ['Shibuya District', 'Harajuku'], faction: 'Jujutsu High', desc: 'The central training grounds. Safe but rarely quiet.' },
    'Shibuya District': { danger: 3, connections: ['Tokyo Jujutsu High Hub', 'Shinjuku', 'Roppongi'], faction: 'neutral', desc: 'A sprawling commercial district hiding curses in plain sight.' },
    'Harajuku': { danger: 2, connections: ['Tokyo Jujutsu High Hub', 'Shibuya District'], faction: 'neutral', desc: 'Fashionable streets where low-level curses lurk in back alleys.' },
    'Shinjuku': { danger: 4, connections: ['Shibuya District', 'Tokyo Station', 'Akihabara'], faction: 'neutral', desc: 'Skyscrapers and shadow. Higher-grade spirits congregate here.' },
    'Roppongi': { danger: 5, connections: ['Shibuya District', 'Akihabara'], faction: 'Geto Cult', desc: 'Contested territory. Cult activity makes this extremely volatile.' },
    'Akihabara': { danger: 3, connections: ['Shinjuku', 'Roppongi'], faction: 'neutral', desc: 'Electric Town. Surveillance-grade curses hide in server farms.' },
    'Tokyo Station': { danger: 4, connections: ['Shinjuku'], faction: 'neutral', desc: 'Underground tunnels and abandoned platforms. Prime curse nesting grounds.' },
    'Odaiba': { danger: 3, connections: ['Roppongi'], faction: 'Jujutsu High', desc: 'A controlled district. Jujutsu High maintains an outpost here.' },
    'Asakusa': { danger: 4, connections: ['Tokyo Station', 'Harajuku'], faction: 'neutral', desc: 'Old Tokyo. Ancient curses tied to the past manifest here.' },
    'Ikebukuro': { danger: 3, connections: ['Shinjuku'], faction: 'neutral', desc: 'Busy entertainment district. Night brings higher danger.' },
    'Yokohama Port': { danger: 5, connections: ['Tokyo Station'], faction: 'neutral', desc: 'Waterfront cargo holds. Special-grade threats occasionally surface.' },
    'Meiji Shrine': { danger: 2, connections: ['Harajuku', 'Shibuya District'], faction: 'Jujutsu High', desc: 'A sacred ground. Curses are weaker but still present at night.' }
};

const ITEMS = {
    'Cursed Nail': { type: 'consumable', effect: 'heal_hp', value: 50, desc: 'A nail from a defeated curse. Restores 50 HP.', price: 80 },
    'Talisman Scroll': { type: 'consumable', effect: 'heal_ce', value: 40, desc: 'Basic purification talisman. Restores 40 CE.', price: 60 },
    'Black Flash Elixir': { type: 'consumable', effect: 'buff_output', value: 0.3, turns: 3, desc: 'Bottled black flash resonance. +30% output for 3 actions.', price: 200 },
    'Domain Shard': { type: 'consumable', effect: 'domain_charge', value: 1, desc: 'Fragment of domain energy. Reduces domain activation cost.', price: 500 },
    'Grade 4 Core': { type: 'material', effect: 'craft', desc: 'Core from a Grade 4 curse. Used for upgrading gear.', price: 100 },
    'Grade 3 Core': { type: 'material', effect: 'craft', desc: 'Core from a Grade 3 curse. Used for advanced crafting.', price: 250 },
    'Grade 2 Core': { type: 'material', effect: 'craft', desc: 'Core from a Grade 2 curse. Rare crafting material.', price: 600 },
    'Grade 1 Core': { type: 'material', effect: 'craft', desc: 'Core from a Grade 1 curse. Extremely rare.', price: 1500 },
    'Special Core': { type: 'material', effect: 'craft', desc: 'Core from a Special Grade curse. Legendary material.', price: 5000 },
    'Cursed Tool Fragment': { type: 'material', effect: 'upgrade', desc: 'Fragment of a cursed tool. Used for weapon upgrades.', price: 300 },
    'Recovery Pill': { type: 'consumable', effect: 'heal_both', value: 40, desc: 'Medical-grade cursed energy pill. Restores 40 HP and 40 CE.', price: 150 },
    'Smoke Bomb': { type: 'consumable', effect: 'escape', value: 1, desc: 'Creates a cursed smoke cloud. Guaranteed escape from non-boss combat.', price: 100 },
    'Stamina Drink': { type: 'consumable', effect: 'stamina', value: 30, desc: 'Restores 30 stamina. Allows immediate action next turn.', price: 40 }
};

const FACTION_REWARDS = {
    'Jujutsu High': { 'Cursed Nail': 5, 'Talisman Scroll': 3, 'Recovery Pill': 2 },
    'Geto Cult': { 'Black Flash Elixir': 1, 'Domain Shard': 1, 'Grade 4 Core': 3 },
    'neutral': {}
};

const ENEMY_POOL = [
    { name: 'Cursed Spirit', minGrade: 4, maxGrade: 4, baseHP: 150 },
    { name: 'Vengeful Spirit', minGrade: 3, maxGrade: 3, baseHP: 180 },
    { name: 'Accursed Corpse', minGrade: 2, maxGrade: 2, baseHP: 220 },
    { name: 'Disaster Curse', minGrade: 1, maxGrade: 1, baseHP: 300 },
    { name: 'Special Grade Entity', minGrade: 0, maxGrade: 0, baseHP: 450 },
    { name: 'Cursed Womb', minGrade: 4, maxGrade: 4, baseHP: 120 },
    { name: 'Born from Fear', minGrade: 3, maxGrade: 3, baseHP: 160 },
    { name: 'Sorcerer Killer', minGrade: 2, maxGrade: 2, baseHP: 200 },
    { name: 'Divine Dog', minGrade: 1, maxGrade: 1, baseHP: 280 },
    { name: 'Finger Bearer', minGrade: 4, maxGrade: 3, baseHP: 140 }
];

const ARMOR_SHOP = [
    { id: 1, name: 'Jujutsu High Standard Uniform', slot: 'armor', cost: 1200, stats: { defense: 15 }, rarity: 'common', rarityName: 'Common', rarityColor: '⚪', effect: { type: 'xp_boost', value: 0.05, desc: 'Increases XP gain by 5%.' } },
    { id: 2, name: 'Reinforced Training Tracksuit', slot: 'armor', cost: 2500, stats: { defense: 25 }, rarity: 'uncommon', rarityName: 'Uncommon', rarityColor: '🟢', effect: { type: 'flee_boost', value: 0.05, desc: '+5% flee success rate.' } },
    { id: 3, name: 'Kyoto Branch Traditional Hakama', slot: 'armor', cost: 18000, stats: { defense: 65 }, rarity: 'rare', rarityName: 'Rare', rarityColor: '🔵', effect: { type: 'ce_reduction', value: 0.10, desc: 'Lowers all technique CE costs by 10%.' } },
    { id: 4, name: 'Grade 2 Tactical Trenchcoat', slot: 'armor', cost: 35000, stats: { defense: 110 }, rarity: 'rare', rarityName: 'Rare', rarityColor: '🔵', effect: { type: 'defense_after_turns', value: 0.20, desc: '+20% defense after 5 turns of combat.' } },
    { id: 5, name: 'Clan Head Haori', slot: 'armor', cost: 120000, stats: { defense: 280 }, rarity: 'epic', rarityName: 'Epic', rarityColor: '🟣', effect: { type: 'max_ce_boost', value: 200, desc: 'Increases maximum CE by +200.' } },
    { id: 6, name: "Shaman's Ritual Robes", slot: 'armor', cost: 250000, stats: { defense: 420 }, rarity: 'epic', rarityName: 'Epic', rarityColor: '🟣', effect: { type: 'curse_damage_reduction', value: 0.50, desc: 'Halves incoming damage from curse enemies.' } },
    { id: 7, name: "Toji's Heavenly Restriction Ward", slot: 'armor', cost: 650000, stats: { defense: 750 }, rarity: 'legendary', rarityName: 'Legendary', rarityColor: '🟡', effect: { type: 'toji_ward', value: 1, desc: 'Negates domain guaranteed-hit. +35% physical damage.' } },
    { id: 8, name: "Shroud of the Four-Armed Calamity", slot: 'armor', cost: 40000000, stats: { defense: 8500 }, rarity: 'mythic', rarityName: 'Mythic', rarityColor: '🔴', effect: { type: 'sukuna_shroud', value: 1, desc: '-75% all damage. Counter-slash below 30% HP.' } },
    { id: 9, name: 'Void Vestments of the Six Eyes', slot: 'armor', cost: 45000000, stats: { defense: 9200 }, rarity: 'mythic', rarityName: 'Mythic', rarityColor: '🔴', effect: { type: 'six_eyes_vestments', value: 1, desc: 'Immune to basic/projectile attacks. Infinite CE.' } },
    { id: 10, name: "Garb of the Thousand-Year Mastermind", slot: 'armor', cost: 42500000, stats: { defense: 8900 }, rarity: 'mythic', rarityName: 'Mythic', rarityColor: '🔴', effect: { type: 'mastermind_garb', value: 1, desc: 'Instant revive at 100% HP/CE on fatal damage (costs 50% K-Coins, 1h cooldown).' } },
    { id: 11, name: "Divine General's Dharma Armor", slot: 'armor', cost: 50000000, stats: { defense: 12000 }, rarity: 'mythic', rarityName: 'Mythic', rarityColor: '🔴', effect: { type: 'dharma_armor', value: 0.25, desc: '+25% defense per turn vs same enemy (stacks to 100%).' } }
];

function getArmorEffect(user, type) {
    const armor = user.equipment?.armor;
    if (!armor || armor === 'None' || !armor.effect) return null;
    if (armor.effect.type === type) return armor.effect.value;
    return null;
}

function getEquippedArmor(user) {
    const armor = user.equipment?.armor;
    if (!armor || armor === 'None') return null;
    return armor;
}

const TECHNIQUE_DISPLAY_NAMES = {
    necrotic_touch: 'Necrotic Touch', spore_bloom: 'Spore Bloom', rooted_decay: 'Rooted Decay', max_gangrene: 'Max Gangrene',
    molt_shrapnel: 'Molt Shrapnel', exoskeleton_aegis: 'Exoskeleton Aegis', bone_thrust: 'Bone Thrust', molting_regen: 'Molting Regen',
    flesh_needle: 'Flesh Needle', echo_sync: 'Echo Sync', siphon_drain: 'Siphon Drain', puppet_fracture: 'Puppet Fracture',
    puddle_evade: 'Puddle Evade', acid_melt: 'Acid Melt', sludge_suffocate: 'Sludge Suffocate', hydro_jet: 'Hydro Jet',
    stray_stitch: 'Stray Stitch', chimera_strike: 'Chimera Strike', trait_plunder: 'Trait Plunder', flesh_reject: 'Flesh Reject',
    suffocating_veil: 'Suffocating Veil', corrosive_breath: 'Corrosive Breath', nerve_pulse: 'Nerve Pulse', max_pestilence: 'Max Pestilence',
    whisper_distract: 'Whisper Distract', doubt_spike: 'Doubt Spike', feedback_loop: 'Feedback Loop', phantom_crowd: 'Phantom Crowd',
    blinded_gaze: 'Blinded Gaze', deafening_silence: 'Deafening Silence', numb_touch: 'Numb Touch', sensory_overload: 'Sensory Overload',
    inverted_fall: 'Inverted Fall', shadow_pit: 'Shadow Pit', nausea_pulse: 'Nausea Pulse', horizon_tilt: 'Horizon Tilt',
    fault_snap: 'Fault Snap', liquefaction_bog: 'Liquefaction Bog', seismic_pulse: 'Seismic Pulse', rock_shield: 'Rock Shield',
    cinder_screen: 'Cinder Screen', oxygen_starvation: 'Oxygen Starvation', superheat_burst: 'Superheat Burst', ash_mimic: 'Ash Mimic',
    gravity_drop: 'Gravity Drop', pressure_bubble: 'Pressure Bubble', implosion_touch: 'Implosion Touch', max_mariana: 'Max Mariana',
    structural_crumble: 'Structural Crumble', weapon_rust: 'Weapon Rust', barrier_decay: 'Barrier Decay', marrow_rot: 'Marrow Rot',
    black_ice_path: 'Black Ice Path', frostbite_spike: 'Frostbite Spike', channel_freeze: 'Channel Freeze', ice_coffin: 'Ice Coffin',
    friction_charge: 'Friction Charge', spark_snap: 'Spark Snap', combustion_trail: 'Combustion Trail', discharge_strike: 'Discharge Strike',
    joy_ruin: 'Joy Ruin', rct_disrupt: 'RCT Disrupt', malice_flip: 'Malice Flip', emotional_drain: 'Emotional Drain',
    residual_feast: 'Residual Feast', vampiric_grapple: 'Vampiric Grapple', spiritual_scavenge: 'Spiritual Scavenge', siphon_shield: 'Siphon Shield',
    swarm_shield: 'Swarm Shield', blinding_cloud: 'Blinding Cloud', shadow_anchor: 'Shadow Anchor', hive_detonation: 'Hive Detonation',
    vow_bait: 'Vow Bait', trifling_tax: 'Trifling Tax', stipulation_shield: 'Stipulation Shield', forfeiture_snap: 'Forfeiture Snap',
    taunt_surge: 'Taunt Surge', fear_feed: 'Fear Feed', hatred_armor: 'Hatred Armor', max_monolithic: 'Max Monolithic',
    barrier_trick: 'Barrier Trick', aesthetic_shift: 'Aesthetic Shift', sure_hit_bluff: 'Sure Hit Bluff', shatter_escape: 'Shatter Escape',
    fate_needle: 'Fate Needle', sympathetic_pain: 'Sympathetic Pain', tether_pull: 'Tether Pull', thread_sever: 'Thread Sever',
    bite_void: 'Bite Void', rift_step: 'Rift Step', spatial_sever: 'Spatial Sever', portal_mirror: 'Portal Mirror',
    sonic_stun: 'Sonic Stun', resonance_shatter: 'Resonance Shatter', amplified_reverb: 'Amplified Reverb', max_banshee: 'Max Banshee',
    brace_impact: 'Brace Impact', stored_release: 'Stored Release', kinetic_brake: 'Kinetic Brake', shockwave_stomp: 'Shockwave Stomp',
    corpse_awaken: 'Corpse Awaken', suicide_bomber: 'Suicide Bomber', meat_wall: 'Meat Wall', blood_link: 'Blood Link',
    abyssal_maw: 'Abyssal Maw', arsenal_drop: 'Arsenal Drop', trap_capture: 'Trap Capture', void_shield: 'Void Shield',
    linear_correction: 'Linear Correction', deflective_path: 'Deflective Path', ricochet_cascade: 'Ricochet Cascade', max_trajectory: 'Max Trajectory',
    grid_swap: 'Grid Swap', intercept_cross: 'Intercept Cross', axis_tilt: 'Axis Tilt', grid_lock: 'Grid Lock',
    ratio_strike: 'Ratio Strike', fractured_guard: 'Fractured Guard', focal_piercing: 'Focal Piercing', collapse_point: 'Collapse Point',
    inertial_brake: 'Inertial Brake', kinetic_release: 'Kinetic Release', air_stride: 'Air Stride', delayed_impact: 'Delayed Impact',
    zero_traction: 'Zero Traction', adhesive_anchor: 'Adhesive Anchor', friction_burn: 'Friction Burn', grip_assist: 'Grip Assist',
    fold_snap: 'Fold Snap', compressed_shield: 'Compressed Shield', pocket_leap: 'Pocket Leap', horizon_pinch: 'Horizon Pinch',
    kanji_shield: 'Kanji Shield', kanji_heavy: 'Kanji Heavy', kanji_burst: 'Kanji Burst', max_scroll: 'Max Scroll',
    crane_scout: 'Crane Scout', needle_swarm: 'Needle Swarm', goliath_toad: 'Goliath Toad', paper_shift: 'Paper Shift',
    frame_drop: 'Frame Drop', stutter_touch: 'Stutter Touch', freeze_frame: 'Freeze Frame', montage_speed: 'Montage Speed',
    crescendo_blast: 'Crescendo Blast', staccato_pulse: 'Staccato Pulse', resonance_wall: 'Resonance Wall', dissonant_chord: 'Dissonant Chord',
    suture_bind: 'Suture Bind', thread_tether: 'Thread Tether', stitch_repair: 'Stitch Repair', grid_net: 'Grid Net',
    capture_frame: 'Capture Frame', flash_release: 'Flash Release', static_delay: 'Static Delay', negative_inverse: 'Negative Inverse',
    aura_sight: 'Aura Sight', pitch_tracking: 'Pitch Tracking', sensory_reroute: 'Sensory Reroute', shatter_tone: 'Shatter Tone',
    sonar_pulse: 'Sonar Pulse', target_lock: 'Target Lock', terrain_hazard: 'Terrain Hazard', flaw_exploit: 'Flaw Exploit',
    structural_break: 'Structural Break', stress_strike: 'Stress Strike', barrier_fracture: 'Barrier Fracture',
    pattern_study: 'Pattern Study', adaptation_barrier: 'Adaptation Barrier', counter_timing: 'Counter Timing', technique_scramble: 'Technique Scramble',
    phantom_blade: 'Phantom Blade', false_venom: 'False Venom', mimic_impact: 'Mimic Impact', placebo_shield: 'Placebo Shield',
    time_dilation: 'Time Dilation', instant_reflex: 'Instant Reflex', trajectory_plot: 'Trajectory Plot', mind_clear: 'Mind Clear',
    restrained_output: 'Restrained Output', shift_clock: 'Shift Clock', bonus_strike: 'Bonus Strike', endurance_drive: 'Endurance Drive',
    pain_ledger: 'Pain Ledger', reciprocal_edge: 'Reciprocal Edge', fatigue_shift: 'Fatigue Shift', redemption_blow: 'Redemption Blow',
    touch_trigger: 'Touch Trigger', drain_cascade: 'Drain Cascade', sprint_advantage: 'Sprint Advantage', tag_transfer: 'Tag Transfer',
    inquiry_lock: 'Inquiry Lock', prohibition_rule: 'Prohibition Rule', truth_bind: 'Truth Bind', contract_nullify: 'Contract Nullify',
    parry_accumulation: 'Parry Accumulation', massive_interest: 'Massive Interest', collateral_claim: 'Collateral Claim', default_crush: 'Default Crush',
    mark_contact: 'Mark Contact', tick_stutter: 'Tick Stutter', zero_hour: 'Zero Hour', interval_reset: 'Interval Reset',
    bio_flash: 'Bio Flash', synapse_burst: 'Synapse Burst', overclock_punch: 'Overclock Punch', max_neuro_collapse: 'Max Neuro Collapse',
    rhythm_match: 'Rhythm Match', phase_strike: 'Phase Strike', vessel_disrupt: 'Vessel Disrupt', harmonic_shield: 'Harmonic Shield',
    sheen_guard: 'Sheen Guard', refractive_deflect: 'Refractive Deflect', glare_flash: 'Glare Flash', prism_dispersion: 'Prism Dispersion',
    heavy_gavel: 'Heavy Gavel', anchor_drop: 'Anchor Drop', light_step: 'Light Step', momentum_anchor: 'Momentum Anchor',
    monofilament_edge: 'Monofilament Edge', shearing_swipe: 'Shearing Swipe', reinforced_core: 'Reinforced Core', edge_extension: 'Edge Extension',
    concealed_reach: 'Concealed Reach', grapple_extended: 'Grapple Extended', quad_guard: 'Quad Guard', phantom_flurry: 'Phantom Flurry'
};

function getTechDisplayName(key) {
    return TECHNIQUE_DISPLAY_NAMES[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// V2 Technique Mastery: track usage, grant XP, level up, unlock passives and evolutions.
const TECHNIQUE_MASTERY_LEVELS = 10;
const TECHNIQUE_MASTERY_XP_PER_LEVEL = 500;
const TECHNIQUE_MASTERY_EVOLUTIONS = {
    'Heavenly Restriction': { evolveAt: 5, newName: 'Primordial Heavenly Restriction', damageBonus: 0.5 },
    'Limitless': { evolveAt: 5, newName: 'Limitless: Full Potential', damageBonus: 0.5 },
    'Cursed Speech': { evolveAt: 5, newName: 'Cursed Speech: Absolute Command', damageBonus: 0.5 },
    'Ten Shadows': { evolveAt: 5, newName: 'Ten Shadows: Complete Manifestation', damageBonus: 0.5 },
    'Boogie Woogie': { evolveAt: 5, newName: 'Boogie Woogie: Instant Clap', damageBonus: 0.5 }
};

function ensureTechniqueMastery(user) {
    if (!user.technique_mastery) user.technique_mastery = {};
    if (!user.technique_stats) user.technique_stats = {};
    return true;
}

function getTechniqueMastery(user, techId) {
    ensureTechniqueMastery(user);
    if (!user.technique_mastery[techId]) {
        user.technique_mastery[techId] = { xp: 0, level: 0, total_damage: 0, uses: 0 };
    }
    return user.technique_mastery[techId];
}

function addTechniqueMasteryXp(user, techId, amount) {
    ensureTechniqueMastery(user);
    const mastery = getTechniqueMastery(user, techId);
    mastery.xp += amount;
    mastery.uses = (mastery.uses || 0) + 1;
    let leveledUp = false;
    while (mastery.xp >= TECHNIQUE_MASTERY_XP_PER_LEVEL && mastery.level < TECHNIQUE_MASTERY_LEVELS) {
        mastery.xp -= TECHNIQUE_MASTERY_XP_PER_LEVEL;
        mastery.level += 1;
        leveledUp = true;
    }
    if (leveledUp && user.statistics) {
        user.statistics.techniques_used = (user.statistics.techniques_used || 0) + 1;
    }
    return leveledUp;
}

function getTechniqueMasteryDamageBonus(user, techId) {
    const mastery = getTechniqueMastery(user, techId);
    if (!mastery.level) return 0;
    return Math.min(mastery.level * 0.05, 0.5);
}

function getTechniqueMasteryCooldownReduction(user, techId) {
    const mastery = getTechniqueMastery(user, techId);
    if (!mastery.level) return 0;
    return Math.min(mastery.level * 0.02, 0.2);
}

function checkTechniqueEvolution(user, techId) {
    const evolution = TECHNIQUE_MASTERY_EVOLUTIONS[techId];
    if (!evolution) return null;
    const mastery = getTechniqueMastery(user, techId);
    if (mastery.level >= evolution.evolveAt && !mastery._evolved) {
        mastery._evolved = true;
        return evolution;
    }
    return null;
}

function recordTechniqueDamage(user, techId, damage) {
    if (!user.statistics) return;
    user.statistics.total_damage_dealt = (user.statistics.total_damage_dealt || 0) + damage;
    const mastery = getTechniqueMastery(user, techId);
    mastery.total_damage = (mastery.total_damage || 0) + damage;
}

function recordCriticalHit(user) {
    if (!user.statistics) return;
    user.statistics.critical_hits = (user.statistics.critical_hits || 0) + 1;
}

function recordPerfectGuard(user) {
    if (!user.statistics) return;
    user.statistics.perfect_guards = (user.statistics.perfect_guards || 0) + 1;
}

// V2 Combat: combo chain tracking
function ensureComboState(combat) {
    if (!combat._combo_chain) {
        combat._combo_chain = { count: 0, last_action_time: 0, multiplier: 1.0, max_combo: 0 };
    }
}

function resetComboChain(combat) {
    if (!combat._combo_chain) return;
    combat._combo_chain.count = 0;
    combat._combo_chain.multiplier = 1.0;
}

function incrementComboChain(combat, now) {
    ensureComboState(combat);
    const window = 4000; // 4s window for combos
    if (now - combat._combo_chain.last_action_time > window) {
        combat._combo_chain.count = 0;
        combat._combo_chain.multiplier = 1.0;
    }
    combat._combo_chain.count += 1;
    combat._combo_chain.last_action_time = now;
    combat._combo_chain.max_combo = Math.max(combat._combo_chain.max_combo || 0, combat._combo_chain.count);
    // Cap multiplier at 3.0x
    combat._combo_chain.multiplier = Math.min(1.0 + (combat._combo_chain.count - 1) * 0.15, 3.0);
    return combat._combo_chain;
}

function getComboMultiplier(combat) {
    ensureComboState(combat);
    return combat._combo_chain.multiplier || 1.0;
}

// V2 Cooldowns
function ensureCooldowns(user) {
    if (!user.combat_cooldowns) user.combat_cooldowns = {};
}

function setCooldown(user, key, durationMs) {
    ensureCooldowns(user);
    user.combat_cooldowns[key] = Date.now() + durationMs;
}

function getCooldownRemaining(user, key) {
    ensureCooldowns(user);
    const until = user.combat_cooldowns[key];
    if (!until) return 0;
    return Math.max(0, until - Date.now());
}

function isOnCooldown(user, key) {
    return getCooldownRemaining(user, key) > 0;
}

// V2 Weapon Mastery
function getWeaponMastery(user, weaponId) {
    if (!user.weapon_mastery) user.weapon_mastery = {};
    if (!user.weapon_mastery[weaponId]) {
        user.weapon_mastery[weaponId] = { xp: 0, level: 0 };
    }
    return user.weapon_mastery[weaponId];
}

function addWeaponMasteryXp(user, weaponId, amount) {
    const mastery = getWeaponMastery(user, weaponId);
    mastery.xp += amount;
    let leveledUp = false;
    while (mastery.xp >= 1000 && mastery.level < 10) {
        mastery.xp -= 1000;
        mastery.level += 1;
        leveledUp = true;
    }
    return leveledUp;
}

function getWeaponMasteryDamageBonus(user, weaponId) {
    const mastery = getWeaponMastery(user, weaponId);
    if (!mastery.level) return 0;
    return Math.min(mastery.level * 0.03, 0.3);
}

// V2 Clan contribution tracking
function recordClanContribution(user, amount) {
    if (!user.clan_contributions) {
        user.clan_contributions = { total_donated: 0, missions_completed: 0 };
    }
    user.clan_contributions.total_donated = (user.clan_contributions.total_donated || 0) + amount;
}

function recordClanMissionComplete(user) {
    if (!user.clan_contributions) {
        user.clan_contributions = { total_donated: 0, missions_completed: 0 };
    }
    user.clan_contributions.missions_completed = (user.clan_contributions.missions_completed || 0) + 1;
}

// V2 Boss encounter tracking
function recordBossEncounter(user, bossId, won, timeMs) {
    if (!user.boss_encounters) user.boss_encounters = {};
    if (!user.boss_encounters[bossId]) {
        user.boss_encounters[bossId] = { attempts: 0, kills: 0, best_time: null };
    }
    const enc = user.boss_encounters[bossId];
    enc.attempts += 1;
    if (won) {
        enc.kills += 1;
        if (!enc.best_time || timeMs < enc.best_time) enc.best_time = timeMs;
    }
}

// V2 Statistics helpers
function recordPvpResult(user, won) {
    if (!user.statistics) return;
    if (won) {
        user.statistics.pvp_wins = (user.statistics.pvp_wins || 0) + 1;
    } else {
        user.statistics.pvp_losses = (user.statistics.pvp_losses || 0) + 1;
    }
}

function recordDungeonClear(user) {
    if (!user.statistics) return;
    user.statistics.dungeons_cleared = (user.statistics.dungeons_cleared || 0) + 1;
}

function recordCurseDefeatStat(user) {
    if (!user.statistics) return;
    user.statistics.curses_defeated = (user.statistics.curses_defeated || 0) + 1;
}

function recordDomainExpansion(user) {
    if (!user.statistics) return;
    user.statistics.domains_expanded = (user.statistics.domains_expanded || 0) + 1;
}

// V2 Prestige
function canPrestige(user) {
    return (user.level || 0) >= 100 && (user.prestige || 0) < 100;
}

function applyPrestige(user) {
    if (!canPrestige(user)) return false;
    user.prestige = (user.prestige || 0) + 1;
    user.prestige_points = (user.prestige_points || 0) + 1;
    user.level = 1;
    user.xp = 0;
    user.xp_needed = 30000;
    user.grade = 4;
    user.stats.HP = 120;
    user.stats.Max_HP = 120;
    user.stats.CE = 100;
    user.stats.Max_CE = 100;
    user.trained_stats = { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 };
    user.wallet = Math.floor(user.wallet * 0.5);
    user.title = 'None';
    user.achievements = [];
    user.quirks = [];
    user.loots = [];
    user.weapons_owned = [];
    user.weapon = null;
    user.wa_attack = 6;
    user.heavenly_restriction = false;
    user._bonus_attack = 0;
    user._bonus_defense = 0;
    user.custom_technique = null;
    user.unlocked_features = { RCT: false, Domain: false, Simple_Domain: false };
    user.technique_1 = null;
    user.technique_2 = null;
    user.technique_3 = null;
    user.technique_4 = null;
    user.technique_5 = null;
    user.technique_6 = null;
    user.skills = {};
    user.unlocked_skills = [];
    user.userSkills = [];
    user._cursed_army = [];
    user._copied_techniques = [];
    user.summon = { active: false, name: 'None', HP: 0, Max_HP: 0, CE: 0, Max_CE: 0, atk: 0, move: null, effect: null, pl: 0 };
    user.active_status_effects = [];
    user.combat_state = { in_combat: false, target: {}, phase: 0, is_ambush: false, field_hazard: 'None', combo: 0, break_charge: 0, counter_state: false };
    user.domain = null;
    user.domain_unlocked = false;
    user.domain_name = null;
    user.domain_await_confirm = false;
    user.domain_await_name = false;
    user.stalker_curse = null;
    user.active_curse_spawn = null;
    user.prisonRealm = null;
    user.cullingGame = { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: 0, techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null };
    user.ownedSummons = [];
    user.inventory = [];
    user.dungeon_state = null;
    user.guild_id = null;
    user.clan = null;
    user.combo_god_until = 0;
    user.corruption = 0;
    user.sanity = 100;
    user.stance = 100;
    user.distance = 5;
    user.loser_until = 0;
    user.quest_log = [];
    user.reputation = { 'Jujutsu High': 0, 'Geto Cult': 0, 'Civilians': 0 };
    user.title_perks_active = [];
    user.technique_mastery = {};
    user.technique_stats = {};
    user.weapon_mastery = {};
    user.statistics = {
        curses_defeated: 0,
        pvp_wins: 0,
        pvp_losses: 0,
        dungeons_cleared: 0,
        techniques_used: 0,
        domains_expanded: 0,
        total_damage_dealt: 0,
        total_damage_taken: 0,
        critical_hits: 0,
        perfect_guards: 0
    };
    user.daily_missions = { date: null, missions: [], claimed: false };
    user.collections = { curses: [], weapons: [], armor: [], summons: [] };
    user.cooldowns = {};
    user.combat_cooldowns = {};
    user.clan_contributions = { total_donated: 0, missions_completed: 0 };
    user.crafting = { recipes: [], materials: {} };
    user.stance_mastery = 0;
    user.domain_mastery = 0;
    user.domain_kills = 0;
    user.boss_encounters = {};
    user.skill_tree_path = [];
    user.skill_tree_points = 0;
    recalcStats(user);
    return true;
}



const SKILL_TREES = {};

const CROSS_UNIVERSE_SKILLS = {
    1: { id: 1, name: 'Rasengan', desc: 'Spiral Sphere: A shape-transformation technique that spins a dense sphere of chakra for grinding kinetic damage.', type: 'ninjutsu', damage: 35, ceCost: 25 },
    2: { id: 2, name: 'Chidori', desc: 'One Thousand Birds: Lightning chakra into the hand for a high-velocity piercing strike.', type: 'ninjutsu', damage: 40, ceCost: 30 },
    3: { id: 3, name: 'Fire Style: Fireball Jutsu', desc: 'Signature Uchiha technique. Compresses molded chakra into a massive sweeping sphere of flame.', type: 'ninjutsu', damage: 45, ceCost: 35 },
    4: { id: 4, name: 'Water Style: Water Dragon Bullet', desc: 'Shapes water into a giant crushing dragon projectile.', type: 'ninjutsu', damage: 40, ceCost: 30 },
    5: { id: 5, name: 'Wind Style: Rasenshuriken', desc: 'Infuses Rasengan with wind-natured chakra, shredding cellular pathways.', type: 'ninjutsu', damage: 55, ceCost: 45 },
    6: { id: 6, name: 'Earth Style: Mud Wall', desc: 'Raises a fortified wall of compacted earth to absorb strikes.', type: 'ninjutsu', damage: 0, ceCost: 20, effect: 'defend', block: 50 },
    7: { id: 7, name: 'Lightning Style: Kirin', desc: 'Draws natural lightning onto a target at supersonic speeds.', type: 'ninjutsu', damage: 60, ceCost: 50 },
    8: { id: 8, name: 'Wood Style: Deep Forest Emergence', desc: 'Forces trees to rapidly grow and wrap around opponents.', type: 'ninjutsu', damage: 35, ceCost: 30, effect: 'immobilize', turns: 1 },
    9: { id: 9, name: 'Sand Tsunami', desc: 'Grinds earth minerals into a massive tidal wave of crushing sand.', type: 'ninjutsu', damage: 50, ceCost: 40 },
    10: { id: 10, name: 'Dust Style: Detonation', desc: 'Kekkei Tōta. Creates a 3D geometric energy structure that pulverizes targets atomically.', type: 'ninjutsu', damage: 80, ceCost: 70 },
    11: { id: 11, name: 'Tsukiyomi', desc: 'High-level illusion trapping the target in a space where the user controls time, mass, and gravity.', type: 'genjutsu', damage: 45, ceCost: 40, effect: 'stun', turns: 1 },
    12: { id: 12, name: 'Tree Binding Death', desc: 'Renders the target paralyzed, hallucinating a tree trunk binding their limbs.', type: 'genjutsu', damage: 20, ceCost: 25, effect: 'immobilize', turns: 2 },
    13: { id: 13, name: 'Izanami', desc: 'Infinite temporal loop genjutsu until target accepts their fate.', type: 'genjutsu', damage: 30, ceCost: 35, effect: 'stun', turns: 2 },
    14: { id: 14, name: 'Izanagi', desc: 'Bypasses reality by turning injuries into dreams.', type: 'genjutsu', damage: 0, ceCost: 50, effect: 'revive' },
    15: { id: 15, name: 'Temple of Nirvana', desc: 'Wide-area illusion raining spectral white feathers, putting targets into deep sleep.', type: 'genjutsu', damage: 0, ceCost: 35, effect: 'sleep', turns: 2 },
    16: { id: 16, name: 'Shadow Clone Jutsu', desc: 'Splits chakra to create physical duplicates that relay experience back.', type: 'taijutsu', damage: 30, ceCost: 30, effect: 'multi_hit', hits: 3 },
    17: { id: 17, name: 'Shadow Possession', desc: 'Extends shadow to connect with opponent, forcing them to mimic movements.', type: 'taijutsu', damage: 0, ceCost: 20, effect: 'immobilize', turns: 1 },
    18: { id: 18, name: 'Expansion Jutsu', desc: 'Drastically increases limb size for raw destructive kinetic power.', type: 'taijutsu', damage: 50, ceCost: 40 },
    19: { id: 19, name: 'Mind Transfer', desc: 'Launches consciousness into target body for complete control.', type: 'taijutsu', damage: 0, ceCost: 45, effect: 'control', turns: 1 },
    20: { id: 20, name: 'Fang Over Fang', desc: 'High-speed drilling strike creating dual piercing vortexes.', type: 'taijutsu', damage: 55, ceCost: 45 },
    21: { id: 21, name: 'Parasitic Insect', desc: 'Hosts insects that feed on enemy chakra for tracking and defense.', type: 'taijutsu', damage: 25, ceCost: 25, effect: 'dot', dot: 8, turns: 3 },
    22: { id: 22, name: 'Dynamic Entry', desc: 'Sudden high-velocity flying kick catching opponents off-guard.', type: 'taijutsu', damage: 40, ceCost: 30 },
    23: { id: 23, name: 'Hidden Shadow Snake Hands', desc: 'Spawns venomous snakes to bind, poison, or drag opponents.', type: 'taijutsu', damage: 30, ceCost: 25, effect: 'poison', dot: 10, turns: 2 },
    24: { id: 24, name: 'Death Controlling Possessed Blood', desc: 'Consumes blood to mirror inflicted damage onto victim.', type: 'taijutsu', damage: 35, ceCost: 30, effect: 'reflect', turns: 2 },
    25: { id: 25, name: 'Primary Lotus', desc: 'High-flying taijutsu drop slamming opponent headfirst into ground.', type: 'taijutsu', damage: 60, ceCost: 50 },
    26: { id: 26, name: 'Amaterasu', desc: 'Spawns unquenchable black flames burning target to ash.', type: 'dojutsu', damage: 70, ceCost: 60 },
    27: { id: 27, name: 'Kamui', desc: 'Warps matter or body parts into a pocket dimension.', type: 'dojutsu', damage: 0, ceCost: 55, effect: 'dodge_next' },
    28: { id: 28, name: 'Susanoo', desc: 'Manifests a massive armored samurai avatar of solid chakra.', type: 'dojutsu', damage: 55, ceCost: 50, effect: 'block', block: 60, turns: 1 },
    29: { id: 29, name: 'Shinra Tensei', desc: 'Omnidirectional gravitational force wave pushing away attacks and landscapes.', type: 'dojutsu', damage: 50, ceCost: 55 },
    30: { id: 30, name: 'Bansho Tenin', desc: 'Reverses gravity to forcefully drag targets toward the user.', type: 'dojutsu', damage: 20, ceCost: 30, effect: 'pull' },
    31: { id: 31, name: 'Chibaku Tensei', desc: 'Spawns a black gravity sphere pulling earth and enemies into a floating moon prison.', type: 'dojutsu', damage: 65, ceCost: 70, effect: 'immobilize', turns: 2 },
    32: { id: 32, name: 'Reaper Death Seal', desc: 'Forbidden sealing technique summoning Shinigami to seal souls eternally.', type: 'dojutsu', damage: 90, ceCost: 80 },
    33: { id: 33, name: 'Flying Raijin', desc: 'Instantly teleports to any marked location.', type: 'dojutsu', damage: 0, ceCost: 30, effect: 'teleport' },
    34: { id: 34, name: 'Sage Art: Frog Kumite', desc: 'Extends physical reach of strikes using natural energy.', type: 's sage', damage: 45, ceCost: 40 },
    35: { id: 35, name: 'Night Guy', desc: 'Apex physical combat kick distorting space and shattering target.', type: 'taijutsu', damage: 95, ceCost: 85 },
    36: { id: 36, name: "Fire Dragon's Roar", desc: 'Breathes a massive concentrated beam of destructive fire.', type: 'dragon_slayer', damage: 50, ceCost: 40 },
    37: { id: 37, name: "Iron Dragon's Scales", desc: 'Covers skin in interlocking iron plates boosting defense and melee damage.', type: 'dragon_slayer', damage: 0, ceCost: 30, effect: 'defend', block: 40, turns: 2 },
    38: { id: 38, name: "Sky Dragon's Wing Attack", desc: 'Generates twin whips of wind throwing opponents aside.', type: 'dragon_slayer', damage: 40, ceCost: 35 },
    39: { id: 39, name: "Lightning Dragon's Heavenward Halberd", desc: 'Shapes lightning into a massive throwing spear causing heavy electric explosion.', type: 'dragon_slayer', damage: 60, ceCost: 50 },
    40: { id: 40, name: "Shadow Dragon's Slash", desc: 'Converts hand into shadow claws phasing through guards.', type: 'dragon_slayer', damage: 45, ceCost: 40 },
    41: { id: 41, name: "White Dragon's Holy Breath", desc: 'Concentrated laser blast of light magic inflicting holy purification.', type: 'dragon_slayer', damage: 50, ceCost: 45 },
    42: { id: 42, name: "Poison Dragon's Fang", desc: 'Covers fists in toxic acid slowly sapping vitality.', type: 'dragon_slayer', damage: 30, ceCost: 30, effect: 'poison', dot: 12, turns: 3 },
    43: { id: 43, name: "Sky Dragon's Healing Spell", desc: 'Restores equilibrium curing motion sickness, fatigue, and minor ailments.', type: 'dragon_slayer', damage: 0, ceCost: 25, effect: 'heal', heal: 50 },
    44: { id: 44, name: "Fire Dragon's Iron Fist", desc: 'Engulfs hand in exploding flames for explosive high-impact punch.', type: 'dragon_slayer', damage: 55, ceCost: 45 },
    45: { id: 45, name: "Iron Dragon's Club", desc: 'Transforms arm into solid iron staff striking at medium range.', type: 'dragon_slayer', damage: 50, ceCost: 40 },
    46: { id: 46, name: 'Ice-Make: Lance', desc: 'Freezes atmospheric moisture into sharp ice spears.', type: 'maker', damage: 35, ceCost: 30 },
    47: { id: 47, name: 'Ice-Make: Shield', desc: 'Fashions a massive shield of non-melting ice blocking projectiles.', type: 'maker', damage: 0, ceCost: 25, effect: 'defend', block: 50, turns: 1 },
    48: { id: 48, name: 'Ice-Make: Floor', desc: 'Coats ground in frictionless ice causing enemies to lose footing.', type: 'maker', damage: 15, ceCost: 25, effect: 'immobilize', turns: 1 },
    49: { id: 49, name: 'Water Slicer', desc: 'Generates high-pressure blade-like waves cutting through stone and steel.', type: 'maker', damage: 40, ceCost: 35 },
    50: { id: 50, name: 'Water Nebula', desc: 'Conjures swirling columns of water crashing down on targets.', type: 'maker', damage: 45, ceCost: 40 },
    51: { id: 51, name: "Giant's Wrath", desc: 'Conjures moving stone fists from ground to pummel targets.', type: 'maker', damage: 50, ceCost: 40 },
    52: { id: 52, name: 'Prominence Whip', desc: 'Generates a flexible whip of fire bypassing obstacles.', type: 'maker', damage: 40, ceCost: 35 },
    53: { id: 53, name: 'Sand Buster', desc: 'Conjures a violent sandstorm vortex suffocating and blinding targets.', type: 'maker', damage: 35, ceCost: 30, effect: 'blind', turns: 1 },
    54: { id: 54, name: 'Wind Wall', desc: 'Spawns a rotating barrier of high-speed air deflecting projectiles.', type: 'maker', damage: 0, ceCost: 30, effect: 'defend', block: 45, turns: 1 },
    55: { id: 55, name: "Heaven's Wheel: Blumenblatt", desc: 'Launches a spiral barrage of magically summoned swords.', type: 'maker', damage: 55, ceCost: 50 },
    56: { id: 56, name: 'Requip: The Knight', desc: 'Instantly summons custom armor and weapons from pocket dimension.', type: 'requip', damage: 0, ceCost: 35, effect: 'buff_attack', value: 20, turns: 2 },
    57: { id: 57, name: 'Celestial Magic: Loke', desc: 'Summons Lion Spirit to fight alongside with light martial arts.', type: 'celestial', damage: 40, ceCost: 35 },
    58: { id: 58, name: 'Celestial Magic: Aquarius', desc: 'Summons Water Bearer Spirit unleashing a massive tidal wave.', type: 'celestial', damage: 55, ceCost: 50 },
    59: { id: 59, name: 'Celestial Magic: Taurus', desc: 'Summons a massive axe-wielding minotaur delivering heavy swings.', type: 'celestial', damage: 50, ceCost: 45 },
    60: { id: 60, name: 'Fairy Glitter', desc: 'One of the Three Great Magics. Concentrated starlight beam vaporizing areas.', type: 'celestial', damage: 75, ceCost: 65 },
    61: { id: 61, name: 'Grand Chariot', desc: 'Summons seven cosmic stars raining in constellation pattern.', type: 'celestial', damage: 65, ceCost: 55 },
    62: { id: 62, name: 'Abyss Break', desc: 'Combines Fire, Water, Wind, Earth into a beam of raw elemental energy.', type: 'caster', damage: 70, ceCost: 60 },
    63: { id: 63, name: 'Territory Magic', desc: 'Manipulates physical coordinates swapping places or redirecting attacks.', type: 'caster', damage: 0, ceCost: 40, effect: 'teleport' },
    64: { id: 64, name: 'Memory-Make: Forgotten Path', desc: 'Remembers observed spells and recreates them instantly.', type: 'caster', damage: 45, ceCost: 40 },
    65: { id: 65, name: 'Gravity Core', desc: 'Artificially increases gravity pinning down opponents.', type: 'caster', damage: 30, ceCost: 35, effect: 'immobilize', turns: 1 },
    66: { id: 66, name: 'Arc of Time: Restore', desc: 'Rewinds or accelerates temporal state of objects.', type: 'caster', damage: 0, ceCost: 40, effect: 'repair' },
    67: { id: 67, name: 'Sleep Magic', desc: 'Expanding wave of tranquilizing circles knocking out low-level targets.', type: 'caster', damage: 0, ceCost: 30, effect: 'sleep', turns: 2 },
    68: { id: 68, name: 'Giant Magic', desc: 'Temporarily expands body to giant proportions scaling defense and power.', type: 'caster', damage: 55, ceCost: 50, effect: 'buff_attack', value: 25, turns: 2 },
    69: { id: 69, name: 'Reflector', desc: 'Warps and reflects physical objects and spells back at attacker.', type: 'caster', damage: 0, ceCost: 35, effect: 'reflect', turns: 1 },
    70: { id: 70, name: 'Fairy Sphere', desc: 'Legendary absolute defense sphere shielding all inside from damage.', type: 'celestial', damage: 0, ceCost: 80, effect: 'invulnerable', turns: 1 }
};

const DARK_CONTINENT_REGIONS = [];
const DARK_REGION_NAMES = [
    'Ravenperch','Crowvolley','Eaglecrest','Falconflight','Hawkeye','Owlcove','Swallowwind','Phoenixflame','Condorpeak','Vulturewatch',
    'Kiteshadow','Harrierdusk','Ospreynest','Kestreldune','Merlinwood','Peregrinefall','Buzzardhill','Lammergeiercliff','Serpentshriek','Honeybuzzardridge',
    'Dragonflymarsh','Beetleburrow','Waspnest','Hornetsting','Butterflygarden','Mothwing','Locustswarm','Grasshopperleap','Fireflyglow','Ladybugspot',
    'Mantisgrove','Stickleaf','Scorpiontail','Centipedecreep','Tarantuladen','Antlionpit','Cicadachoir','Cricketchirp','Termitemound','Antcolony',
    'Beehive','Fleahide','Tickburrow','Mitehive','Silverfishstream','Mayflyrush','Stoneflyrock','Dobsonflyjaw','Lacewingvein','Snakeflysting',
    'Scorpionflytail','Caddisflycase','Craneflydance','Robberflystrike','Horseflygallop','Deerflytrail','Botflylarva','Blowflybuzz','Fleshflyfeed','Hoverflyhover',
    'Beeflydrone','Soldierflymarch','Waterstrider','Pondskater','Backswimmer','Divingbeetle','Whirligigbeetle','Glowwormcave','Leafhopper','Planthopper',
    'Treehopper','Spittlebug','Froghopper','Assassinbug','Waterbug','Toadbug','Cicadahell','Mothlight','Beetlecarapace','Waspsting',
    'Hornetthrone','Antswarm','Termiteking','Locustcloud','Dragonflydance','Butterflyeffect','Fireflybeacon','Ladybugfield','Mantispray','Stickbugcamouflage',
    'Sparrowflight','Wrennest','Nightingaledell','Robinroost','Blackbirdthorn','Jayperch','Nuthatchbark','Treecreepervine','Thrushgrove','Magpieglen'
];
for (let i = 1; i <= 100; i++) {
    DARK_CONTINENT_REGIONS.push({
        id: i,
        name: DARK_REGION_NAMES[i - 1] || `Dark Region ${i}`,
        level: 30 + Math.floor(i / 5),
        danger: Math.min(5, 1 + Math.floor(i / 20)),
        logbook: [],
        explored: false,
        exploredBy: [],
        curses: [],
        treasure: null
    });
}

const PANDORAS_KINGS = [
    { id: 'ashen_harvester', name: 'The Ashen Harvester: Chernobog', origin: 'Eastern European Wilderness Nodes', grade: 'Special Grade', hp: 52000, ce: 28500, pl: 96200, biometrics: 'Manifested from centuries of freezing isolation, nighttime terror, and the fear of complete, localized crop failure.' },
    { id: 'void_weaver', name: 'Void Weaver: Anansi\'s Brood', origin: 'West African Folklore Sectors', grade: 'Special Grade', hp: 46800, ce: 32000, pl: 91500, biometrics: 'Birth from the fear of invisible manipulation, mental traps, and being completely trapped within a web of lies or misfortune.' },
    { id: 'concrete_womb', name: 'Giga-Structure: The Concrete Womb', origin: 'High-Density Metropolis Hubs', grade: 'Special Grade', hp: 65000, ce: 22000, pl: 88400, biometrics: 'Formed from urban claustrophobia, industrial decay, and the collective despair of millions living in overcrowded, oppressive cities.' },
    { id: 'static_specter', name: 'Internet Myth: The Static Specter', origin: 'Deep Web Rupture Grids', grade: 'Special Grade', hp: 41000, ce: 35000, pl: 85100, biometrics: 'Fueled by modern techno-paranoia, mass data surveillance leaks, and the fear of digital identity erasure.' },
    { id: 'trench_leviathan', name: 'Abyssal Monolith: Trench Leviathan', origin: 'Oceanic Bed Boundaries', grade: 'Special Grade', hp: 58500, ce: 25000, pl: 83900, biometrics: 'Sustained by global thalassophobia—the severe, ancient human fear of deep, dark open waters and massive underwater masses.' }
];

const WORLD_NATIONS = {
    spriggan: { name: 'Nation of Spriggan', color: '#2e8b57', villages: ['Verdant Vale','Spriggan Hold','Rootspire','Thornwall','Canopy Commons'] },
    ishgar: { name: 'Nation of Ishgar', color: '#4a90d9', villages: ['Azure Bay','Ishgar Citadel','Stormveil','Ironhaven','Seabound'] }
};

function ensureDarkContinent() {
    if (!db.darkContinent) db.darkContinent = { active: true, regions: {}, shards: [], pandoraBox: { locked: true, keyFound: false, kingsUnleashed: false, gojoEncountered: false }, lastRotation: Date.now() };
    if (!db.darkContinent.regions || Object.keys(db.darkContinent.regions).length === 0) {
        DARK_CONTINENT_REGIONS.forEach(r => {
            db.darkContinent.regions[r.id] = { ...r, logbook: [], explored: false, exploredBy: [], curses: [], treasure: null, environmental: generateEnvironmentalHazard(r.id), subRegions: [] };
        });
    } else {
        Object.values(db.darkContinent.regions).forEach(r => {
            if (!Array.isArray(r.subRegions)) r.subRegions = [];
            if (!Array.isArray(r.curses)) r.curses = [];
        });
    }
    if (!db.darkContinent.shards) db.darkContinent.shards = [];
    if (db.darkContinent.shards.length < 4) {
        while (db.darkContinent.shards.length < 4) {
            const rid = 1 + Math.floor(Math.random() * 100);
            if (!db.darkContinent.shards.includes(rid)) db.darkContinent.shards.push(rid);
        }
    }
    if (!db.darkContinent.pandoraBox) db.darkContinent.pandoraBox = { locked: true, keyFound: false, kingsUnleashed: false, gojoEncountered: false };
}

// ── Environmental Hazards ──
const ENVIRONMENTAL_HAZARDS = [
    { name: 'Miasma Veil', effect: 'decay', desc: 'Toxic air drains 3% Max HP/CE per turn.', hpDrain: 0.03, ceDrain: 0.03 },
    { name: 'Gravity Inversion', effect: 'gravity', desc: 'Melee attacks miss for 3 turns. Projectile skills deal 2x damage.', turns: 3 },
    { name: 'Eternal Fog', effect: 'fog', desc: 'Coordinates are scrambled. Enemy HP and buffs are hidden.', turns: 999 },
    { name: 'Soul Rot', effect: 'sanity_drain', desc: 'Sanity drains 5/turn. Hallucinations begin below 40 sanity.', sanityDrain: 5 },
    { name: 'Blood Moon', effect: 'berserk', desc: 'All damage increased by 30% for both sides.', damageMult: 1.3 },
    { name: 'Static Field', effect: 'stun_chance', desc: '30% chance to stun on any physical contact.', stunChance: 0.3 },
    { name: 'Void Winds', effect: 'distance_pull', desc: 'Distance increases by 10 every turn. Ranged attacks only.', distanceIncrease: 10 }
];

function generateEnvironmentalHazard(regionId) {
    const roll = Math.random();
    if (roll < 0.3) return null; // 30% chance no hazard
    const hazard = ENVIRONMENTAL_HAZARDS[Math.floor(Math.random() * ENVIRONMENTAL_HAZARDS.length)];
    return { ...hazard, id: Date.now() + Math.random() };
}

// ── Sub-Regions (Horror-themed) ──
const ANIME_SUBREGION_NAMES = [
    'Goku','Luffy','Naruto','Saitama','Ichigo','Tanjiro','Natsu','Gintoki','Spike','Alucard',
    'Edward','Light','Levi','Mikasa','Killua','Hisoka','Kenshin','Spider-Man','Deku','Shoto',
    'Denji','Gojo','Yuta','Megumi','Nobara','Sukuna','Toji','Maki','Panda','Toge',
    'Yuki','Kaguya','Bakugo','Uraraka','Jotaro','Dio','Asta','Yuno','Shinra','Arthur',
    'Rengoku','Sanemi','Obanai','Mitsuri','Gyomei','Tengen','Muichiro','Giyu','Akaza','Douma',
    'Kanao','Inosuke','Zenitsu','Koma','Genya','Nezuko','Tanjiro','Zenitsu','Inosuke','Giyu',
    'Lelouch','Vegeta','Kakashi','Itachi','Madara','Orochimaru','Jiraiya','Tsunade','Hinata','Shikamaru',
    'Chrollo','Kurapika','Feitan','Phinks','Franklin','Biscuit','Kite','Gon','Meruem','Netero',
    'Rimuru','Veldora','Hakuro','Benimaru','Shion','Souei','Diablo','Ranga','Gobta','Milim',
    'Ainz','Albedo','Rem','Ram','Emilia','Subaru','Puck','Reinhard','Julius','Roswaal'
];

function generateSubRegions(regionId) {
    const region = ensureRegion(regionId);
    if (!region || region.subRegions?.length) return region.subRegions || [];
    
    const count = 20;
    const subRegions = [];
    const usedNames = new Set();
    
    for (let i = 0; i < count; i++) {
        let name;
        do {
            name = ANIME_SUBREGION_NAMES[Math.floor(Math.random() * ANIME_SUBREGION_NAMES.length)];
            if (!usedNames.has(name)) break;
        } while (true);
        
        usedNames.add(name);
        const hazard = generateEnvironmentalHazard(regionId);
        const curseCount = 1 + Math.floor(Math.random() * 3);
        const curses = [];
        const curseNames = ['Cursed Spirit','Accursed Corpse','Disaster Curse','Vengeful Spirit','Born from Fear','Finger Bearer','Corrupted Sorcerer','Womb Curse','Hollow Shade','Rot Walker'];
        
        for (let j = 0; j < curseCount; j++) {
            curses.push({
                name: curseNames[Math.floor(Math.random() * curseNames.length)],
                grade: Math.min(4, Math.max(0, Math.floor((region.level || 30) / 15) + Math.floor(Math.random() * 2) - 1)),
                hp: 80 + Math.floor(Math.random() * 200),
                ce: 60 + Math.floor(Math.random() * 150)
            });
        }
        
        subRegions.push({
            id: `${regionId}-${i}`,
            name: `${name}`,
            level: region.level + Math.floor(Math.random() * 10),
            danger: Math.min(5, region.danger + Math.floor(Math.random() * 2)),
            environmental: hazard,
            curses,
            treasure: generateRegionTreasure(regionId),
            explored: false,
            exploredBy: [],
            logbook: []
        });
    }
    
    region.subRegions = subRegions;
    return subRegions;
}

// ── Sanity System ──
function tickSanity(user, combat) {
    if (!user || !user.sanity || user.sanity <= 0) return;
    const region = getUserRegion(user);
    if (!region?.environmental) return;
    
    const env = region.environmental;
    if (env.effect === 'sanity_drain') {
        user.sanity = Math.max(0, user.sanity - (env.sanityDrain || 5));
    }
    
    // Hallucination system below 40% sanity
    if (user.sanity < 40 && Math.random() < 0.3 && combat) {
        combat.hallucination = true;
    }
    
    // Despair state at 0% sanity
    if (user.sanity <= 0) {
        user.sanity = 0;
        user.active_status_effects = user.active_status_effects || [];
        const hasPanic = user.active_status_effects.find(s => s.name === 'PANIC');
        if (!hasPanic) {
            user.active_status_effects.push({ name: 'PANIC', turns: 999, evasion: 0, damageTakenMult: 1.5 });
        }
    }
}

function getUserRegion(user) {
    if (!db.darkContinent?.regions) return null;
    return Object.values(db.darkContinent.regions).find(r => r.exploredBy?.includes(user.player_id)) || null;
}

// ── Stance Break System ──
function applyStanceDamage(user, damage) {
    if (!user || !user.stance) return;
    user.stance = Math.max(0, user.stance - damage);
    if (user.stance <= 0) {
        user.stance = 0;
        user.stanceBroken = true;
        user.stanceBreakTurns = 2;
    }
}

function tickStance(user) {
    if (!user || !user.stanceBroken) return;
    user.stanceBreakTurns = (user.stanceBreakTurns || 1) - 1;
    if (user.stanceBreakTurns <= 0) {
        user.stanceBroken = false;
        user.stanceBreakTurns = 0;
        user.stance = 100;
    }
}

// ── Distance System ──
function updateCombatDistance(combat, distanceChange) {
    if (!combat) return;
    combat.distance = Math.max(1, Math.min(50, (combat.distance || 5) + (distanceChange || 0)));
}

function canMeleeAttack(distance) { return distance <= 3; }
function canRangedAttack(distance) { return distance >= 10; }

// ── Status Effect Interlocking ──
function applyStatusInterlocking(combat, user, enemy, skillEffect) {
    if (!combat || !user || !enemy) return [];
    const effects = [];
    
    // Conductive Loop: Water/Ice + Lightning = 2.5x damage + spread
    const playerWet = combat.playerStatus?.find(s => s.type === 'WET');
    const skillType = skillEffect?.toLowerCase() || '';
    if (playerWet && (skillType.includes('lightning') || skillType.includes('chidori') || skillType.includes('electric'))) {
        effects.push({ type: 'CONDUCTIVE', name: 'Conductive Loop', dot: 0, turns: 1, mult: 2.5, spread: true });
    }
    
    // Blood-Rot Catalyst: Bleeding weapon + poison = 2x poison tick
    const enemyBleeding = combat.enemyStatus?.find(s => s.type === 'BLEED');
    if (enemyBleeding && skillType.includes('poison')) {
        effects.push({ type: 'BLOOD_ROT', name: 'Blood-Rot Catalyst', dot: 0, turns: enemyBleeding.turns, mult: 2.0 });
    }
    
    return effects;
}

// ── Fog of War ──
function applyFogOfWar(combat, user) {
    if (!combat || !user) return;
    const region = getUserRegion(user);
    if (!region?.environmental || region.environmental.effect !== 'fog') return;
    
    // Scramble enemy HP display
    if (combat.enemy?.stats?.HP && Math.random() < 0.5) {
        const variance = Math.floor(combat.enemy.stats.Max_HP * 0.3);
        combat.enemy.stats.HP = Math.max(1, combat.enemy.stats.HP + (Math.random() < 0.5 ? -variance : variance));
    }
    
    // Hide buffs
    if (Math.random() < 0.4) {
        combat.enemyGuarding = false;
        combat.enemyStunned = 0;
    }
}

// ── Region Rotation ──
function rotateRegions() {
    const now = Date.now();
    if (!db.darkContinent?.lastRotation || now - db.darkContinent.lastRotation < 24 * 60 * 60 * 1000) return;
    
    db.darkContinent.lastRotation = now;
    const regions = db.darkContinent.regions || {};
    
    // Increase danger levels
    for (const r of Object.values(regions)) {
        r.danger = Math.min(5, (r.danger || 1) + 1);
        r.level = Math.max(30, (r.level || 30) + 5);
        r.environmental = generateEnvironmentalHazard(r.id);
        
        // Reset explored status for new day
        r.explored = false;
        r.exploredBy = [];
        r.logbook = [];
        r.curses = [];
        r.treasure = null;
        
        // Generate new curses
        generateRegionCurses(r.id);
        generateRegionTreasure(r.id);
    }
    
    saveDb();
}

// Call rotation check periodically
setInterval(rotateRegions, 60 * 60 * 1000); // Check every hour

function ensureRegion(regionId) {
    ensureDarkContinent();
    const r = db.darkContinent.regions[regionId];
    if (!r) return null;
    if (!r.curses) r.curses = [];
    if (!r.logbook) r.logbook = [];
    if (!r.exploredBy) r.exploredBy = [];
    return r;
}

function getRandomRegionId() { return 1 + Math.floor(Math.random() * 100); }

function generateRegionCurses(regionId) {
    const r = ensureRegion(regionId);
    if (!r || r.curses.length > 0) return r ? r.curses : [];
    const count = 2 + Math.floor(Math.random() * 4);
    const names = ['Cursed Spirit','Accursed Corpse','Disaster Curse','Vengeful Spirit','Born from Fear','Finger Bearer','Corrupted Sorcerer','Womb Curse'];
    for (let i = 0; i < count; i++) {
        r.curses.push({ name: names[Math.floor(Math.random() * names.length)], grade: Math.min(4, Math.max(0, Math.floor((r.level || 30) / 15))), hp: 80 + Math.floor(Math.random() * 200), ce: 60 + Math.floor(Math.random() * 150) });
    }
    return r.curses;
}

function generateRegionTreasure(regionId) {
    const r = ensureRegion(regionId);
    if (!r) return null;
    if (r.treasure) return r.treasure;
    const roll = Math.random();
    let treasure = null;
    if (roll < 0.08) {
        const shardIds = db.darkContinent?.shards || [];
        if (shardIds.includes(regionId) && !db.darkContinent.pandoraBox?.keyFound) {
            treasure = { type: 'shard', name: 'Pandora Shard', desc: 'A glowing fragment of the key to Pandora\'s Box.', found: false };
        }
    } else if (roll < 0.25) {
        const gold = 5000 + Math.floor(Math.random() * 50000);
        treasure = { type: 'gold', name: 'Ancient Cache', desc: `Hidden treasure containing ${gold} K-Coins.`, gold, found: false };
    } else if (roll < 0.35) {
        const skillId = 1 + Math.floor(Math.random() * 70);
        treasure = { type: 'skill', name: 'Ancient Scroll', desc: `A scroll containing the knowledge of ${CROSS_UNIVERSE_SKILLS[skillId]?.name || 'a forgotten technique'}.`, skillId, found: false };
    }
    r.treasure = treasure;
    return treasure;
}

function discoverTreasure(regionId, userJid) {
    const r = ensureRegion(regionId);
    if (!r || !r.treasure || r.treasure.found) return null;
    r.treasure.found = true;
    const user = db.users[userJid];
    const name = user?.name || 'Unknown';
    let logEntry = `${new Date().toLocaleTimeString()} — ${name} discovered: ${r.treasure.name}`;
    if (r.treasure.type === 'gold' && user) {
        user.wallet = (user.wallet || 0) + (r.treasure.gold || 0);
        logEntry += ` (${r.treasure.gold} K-Coins)`;
    } else if (r.treasure.type === 'skill' && user) {
        if (user.heavenly_restriction) {
            const quirkKeys = Object.keys(QUIRKS);
            const randomQuirkId = quirkKeys[Math.floor(Math.random() * quirkKeys.length)];
            const quirk = QUIRKS[randomQuirkId];
            if (!Array.isArray(user.quirks)) user.quirks = [];
            if (user.quirks.length < 2 && !user.quirks.find(q => q.id === quirk.id)) {
                user.quirks.push(quirk);
                logEntry += ` — Quirk awakened: ${quirk.name}`;
            } else {
                logEntry += ' (Quirk inventory full or already known)';
            }
        } else {
            const skillId = r.treasure.skillId;
            if (!db.userSkills) db.userSkills = {};
            if (!db.userSkills[userJid]) db.userSkills[userJid] = [];
            if (!db.userSkills[userJid].includes(skillId) && db.userSkills[userJid].length < 10) {
                db.userSkills[userJid].push(skillId);
                const s = CROSS_UNIVERSE_SKILLS[skillId];
                logEntry += ` — Learned: ${s?.name || 'Unknown Skill'}`;
            } else {
                logEntry += ' (Skill already known or inventory full)';
            }
        }
    } else if (r.treasure.type === 'shard') {
        logEntry += ' — Pandora Shard acquired!';
    }
    if (!r.logbook.includes(logEntry)) r.logbook.push(logEntry);
    if (r.logbook.length > 50) r.logbook = r.logbook.slice(-50);
    saveDb();
    return { ...r.treasure, logEntry };
}

function scatterFingersInDarkContinent() {
    ensureDarkContinent();
    db.darkContinent.shards = [];
    for (let i = 0; i < 4; i++) {
        const rid = 1 + Math.floor(Math.random() * 100);
        if (!db.darkContinent.shards.includes(rid)) db.darkContinent.shards.push(rid);
    }
    db.scatteredFingers = 20;
    db.sukunaFingers = { remaining: 20, curses: {} };
    CURSES.slice(0, 20).forEach((c, i) => { db.sukunaFingers.curses[i] = { name: c.name, taken: false, takenBy: null }; });
}

function drawWorldMap() {
    const W = 900, H = 700;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, W, H);
    const drawCoastline = (points, color, fill) => {
        ctx.fillStyle = fill;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length - 2; i++) {
            const xc = (points[i][0] + points[i + 1][0]) / 2;
            const yc = (points[i][1] + points[i + 1][1]) / 2;
            ctx.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    };
    drawCoastline([[80, 80], [200, 60], [350, 90], [380, 180], [340, 260], [280, 300], [200, 280], [120, 240], [60, 160]], '#2e8b57', '#0d2818');
    drawCoastline([[420, 140], [580, 120], [720, 160], [800, 240], [780, 340], [680, 380], [560, 360], [480, 300], [440, 220]], '#4a6d8c', '#0f1f2e');
    ctx.fillStyle = '#1a4d2e';
    ctx.beginPath(); ctx.moveTo(150, 120); ctx.lineTo(250, 110); ctx.lineTo(280, 160); ctx.lineTo(240, 200); ctx.lineTo(160, 190); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#2c3e50';
    ctx.beginPath(); ctx.moveTo(580, 180); ctx.lineTo(680, 170); ctx.lineTo(720, 220); ctx.lineTo(680, 280); ctx.lineTo(600, 260); ctx.closePath(); ctx.fill();
    const villages = Object.values(db.villages || {});
    if (villages.length > 0) {
        const plotVillage = (v, x, y, colonised) => {
            ctx.fillStyle = colonised ? '#ff6b6b' : '#ffd700';
            ctx.beginPath(); ctx.arc(x, y, colonised ? 4 : 3, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = '#ffffff'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
            const maxChars = 12;
            const name = v.name.length > maxChars ? v.name.slice(0, maxChars - 1) + '…' : v.name;
            ctx.fillText(name, x + 5, y + 3);
        };
        villages.forEach((v, i) => {
            const nationIndex = i < 250 ? 0 : 1;
            const indexInNation = nationIndex === 0 ? i : i - 250;
            const villagesPerNation = 250;
            const cols = 25;
            const nationX = nationIndex === 0 ? 80 : 480;
            const nationY = 100;
            const spacingX = 28;
            const spacingY = 18;
            const col = indexInNation % cols;
            const row = Math.floor(indexInNation / cols);
            const x = nationX + col * spacingX + (Math.random() - 0.5) * 6;
            const y = nationY + row * spacingY + (Math.random() - 0.5) * 6;
            const clampedX = Math.max(20, Math.min(W - 20, x));
            const clampedY = Math.max(40, Math.min(H - 20, y));
            plotVillage(v, clampedX, clampedY, !!v.colonisedBy);
        });
    } else {
        const defaultVillages = [
            { name: 'Verdant Vale', x: 160, y: 130 }, { name: 'Spriggan Hold', x: 220, y: 150 },
            { name: 'Rootspire', x: 180, y: 190 }, { name: 'Thornwall', x: 250, y: 180 }, { name: 'Canopy Commons', x: 200, y: 220 },
            { name: 'Azure Bay', x: 600, y: 200 }, { name: 'Ishgar Citadel', x: 660, y: 220 },
            { name: 'Stormveil', x: 640, y: 260 }, { name: 'Ironhaven', x: 700, y: 240 }, { name: 'Seabound', x: 620, y: 280 }
        ];
        defaultVillages.forEach(v => {
            ctx.fillStyle = '#ffd700';
            ctx.beginPath(); ctx.arc(v.x, v.y, 4, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = '#ffffff'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
            ctx.fillText(v.name, v.x + 7, v.y + 3);
        });
    }
    ctx.fillStyle = '#ff4444'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
    ctx.fillText('KENNYJAKS WORLD MAP', W / 2, 30);
    ctx.fillStyle = '#aaaaaa'; ctx.font = '12px monospace';
    ctx.fillText(`Nations: Spriggan | Ishgar | ${villages.length} villages | Use .dmap for the Dark Continent`, W / 2, H - 15);
    return canvas;
}

function drawDarkContinentMap() {
    const W = 1000, H = 800;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, W, H);
    const drawLandmass = (points, color, stroke) => {
        ctx.fillStyle = color;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length - 2; i++) {
            const xc = (points[i][0] + points[i + 1][0]) / 2;
            const yc = (points[i][1] + points[i + 1][1]) / 2;
            ctx.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    };
    drawLandmass([[80, 100], [250, 60], [450, 80], [650, 70], [850, 110], [920, 250], [880, 450], [750, 600], [550, 720], [350, 740], [150, 650], [60, 450], [50, 250]], '#0d1f12', '#1a3a1a');
    drawLandmass([[200, 180], [320, 160], [400, 200], [380, 300], [300, 340], [220, 300], [180, 240]], '#0a1a0d', '#153015');
    drawLandmass([[550, 200], [700, 180], [780, 240], [760, 360], [650, 400], [560, 340], [520, 260]], '#0d1f12', '#1a3a1a');
    const cols = 10, rows = 10;
    const cellW = Math.floor((W - 80) / cols);
    const cellH = Math.floor((H - 120) / rows);
    const startX = 40, startY = 80;
    for (let i = 0; i < 100; i++) {
        const col = i % cols, row = Math.floor(i / cols);
        const x = startX + col * cellW, y = startY + row * cellH;
        const region = db.darkContinent?.regions[i + 1];
        const hasShard = db.darkContinent?.shards?.includes(i + 1);
        const isPandora = i === 44;
        ctx.fillStyle = isPandora ? 'rgba(255, 0, 255, 0.12)' : (hasShard ? 'rgba(255, 215, 0, 0.08)' : 'rgba(20, 40, 20, 0.5)');
        ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
        ctx.strokeStyle = isPandora ? '#ff00ff' : (hasShard ? '#ffd700' : 'rgba(40, 80, 40, 0.6)');
        ctx.lineWidth = isPandora ? 2 : 1;
        ctx.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
        ctx.fillStyle = '#e0e0e0';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        const label = isPandora ? 'PANDORA\'S BOX' : (region?.name ? region.name.slice(0, 16) : `REGION ${i + 1}`);
        ctx.fillText(label, x + cellW / 2, y + cellH / 2 - 5);
        if (region?.explored) {
            ctx.fillStyle = '#00cc66';
            ctx.font = '8px monospace';
            ctx.fillText('EXPLORED', x + cellW / 2, y + cellH / 2 + 8);
        } else if (hasShard) {
            ctx.fillStyle = '#ffd700';
            ctx.font = '8px monospace';
            ctx.fillText('? SHARD ?', x + cellW / 2, y + cellH / 2 + 8);
        }
    }
    ctx.fillStyle = '#ff4444';
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('THE DARK CONTINENT', W / 2, 35);
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '12px monospace';
    ctx.fillText(`Pandora Shards: ${(db.darkContinent?.shards || []).length}/4 remaining | Pandora's Box: Region 44`, W / 2, H - 20);
    return canvas;
}

const RARITY_TIERS = [
    { id: 'common', name: 'Common', color: '⚪', statMult: 1.0 },
    { id: 'uncommon', name: 'Uncommon', color: '🟢', statMult: 1.2 },
    { id: 'rare', name: 'Rare', color: '🔵', statMult: 1.5 },
    { id: 'epic', name: 'Epic', color: '🟣', statMult: 2.0 },
    { id: 'legendary', name: 'Legendary', color: '🟡', statMult: 3.0 },
    { id: 'artifact', name: 'Artifact', color: '🔴', statMult: 5.0 }
];

const EQUIPMENT_DB = {
    'Rusty Katana': { type: 'weapon', slot: 'weapon', baseAttack: 8, baseDefense: 0 },
    'Iron Blade': { type: 'weapon', slot: 'weapon', baseAttack: 15, baseDefense: 0 },
    'Cursed Steel Sword': { type: 'weapon', slot: 'weapon', baseAttack: 25, baseDefense: 5 },
    'Inverted Spear of Heaven': { type: 'weapon', slot: 'weapon', baseAttack: 40, baseDefense: 10 },
    'Claws of the Fallen': { type: 'weapon', slot: 'weapon', baseAttack: 35, baseDefense: 0 },
    'Tantō of Shadows': { type: 'weapon', slot: 'weapon', baseAttack: 30, baseDefense: 5 },
    'Leather Jacket': { type: 'armor', slot: 'armor', baseAttack: 0, baseDefense: 10 },
    'Chainmail Vest': { type: 'armor', slot: 'armor', baseAttack: 0, baseDefense: 20 },
    'Cursed Battle Suit': { type: 'armor', slot: 'armor', baseAttack: 5, baseDefense: 35 },
    'Jujutsu High Uniform': { type: 'armor', slot: 'armor', baseAttack: 0, baseDefense: 25 },
    'Ring of Protection': { type: 'accessory', slot: 'accessory', baseAttack: 0, baseDefense: 15 },
    'Cursed Energy Amulet': { type: 'accessory', slot: 'accessory', baseAttack: 10, baseDefense: 10 },
    'Sukuna\'s Finger': { type: 'relic', slot: 'relic', baseAttack: 20, baseDefense: 20 }
};

const TITLE_PERKS = {
    'None': {},
    'Loser': { penalty_attack: -5, penalty_speed: -2 },
    'High Roller': { bonus_crit: 0.1, bonus_gold: 0.1 },
    'The Strongest One': { bonus_attack: 20, bonus_defense: 10, bonus_hp: 50 },
    'Domain Expander': { domain_power: 0.2 },
    'Curse Slayer': { bonus_damage_vs_curse: 0.2 },
    'Sorcerer Hunter': { bonus_damage_vs_sorcerer: 0.2 },
    'Vengeful': { stalker_power: 0.3 },
    'Explorer': { bonus_explore_xp: 0.15 },
    'Dungeon Champion': { bonus_dungeon_reward: 0.2 },
    'Guild Leader': { guild_bonus: 0.1 },
    'Gambler': { bonus_gamble_win: 0.05 },
    'Survivor': { bonus_hp_low: 0.2 },
    'Technique Master': { bonus_technique_damage: 0.15 },
    'RCT Specialist': { bonus_rct_heal: 0.25 }
};

const ACHIEVEMENT_DEFS = {
    'first_blood': { name: 'First Blood', desc: 'Win your first combat', condition: (u) => u.consecutive_wins >= 1 },
    'veteran': { name: 'Veteran', desc: 'Reach level 60', condition: (u) => u.level >= 60 },
    'elite': { name: 'Elite', desc: 'Reach level 25', condition: (u) => u.level >= 25 },
    'master': { name: 'Master', desc: 'Reach level 50', condition: (u) => u.level >= 50 },
    'explorer': { name: 'Explorer', desc: 'Discover 5 locations', condition: (u) => (u.discovered_locations?.length || 0) >= 5 },
    'rich': { name: 'Rich', desc: 'Have 1T gold', condition: (u) => (u.wallet || 0) >= 1_000_000_000_000 },
    'millionaire': { name: 'Millionaire', desc: 'Have 100M gold', condition: (u) => (u.wallet || 0) >= 100_000_000 },
    'technician': { name: 'Technician', desc: 'Unlock all 4 techniques', condition: (u) => !!u.technique_1 && !!u.technique_2 && !!u.technique_3 && !!u.technique_4 },
    'domain_user': { name: 'Domain User', desc: 'Unlock Domain Expansion', condition: (u) => !!u.unlocked_features?.Domain },
    'stalker_hunter': { name: 'Stalker Hunter', desc: 'Survive 3 stalker ambushes', condition: (u) => (u.damage_taken || 0) >= 3 },
    'gambler': { name: 'Gambler', desc: 'Win 10 gambles', condition: (u) => false },
    'dungeon_crawler': { name: 'Dungeon Crawler', desc: 'Complete 5 dungeons', condition: (u) => false },
    'besto_friendo': { name: 'Besto Friendo', desc: 'Complete a tag team mission with a sorcerer NPC', condition: (u) => (u.achievements || []).includes('besto_friendo') }
};

const DUNGEON_TEMPLATES = [
    {
        id: 1, name: 'Cursed Womb Catacombs', minLevel: 1, floors: 5, ce_cost: 20,
        desc: 'An underground labyrinth infested with cursed spirits. Deeper floors hold stronger entities.',
        enemies: ['Cursed Spirit', 'Cursed Womb', 'Born from Fear', 'Vengeful Spirit', 'Special Grade Entity'],
        boss: 'Womb Curse Sovereign',
        bossPhases: [
            { hpPct: 0.75, name: 'Womb Curse Sovereign (Phase 2)', effect: 'enrage', desc: 'The sovereign pulses with dark energy — damage increased 25%!' },
            { hpPct: 0.5, name: 'Womb Curse Sovereign (Phase 3)', effect: 'summon', desc: 'The sovereign summons 2 minions to aid it!' },
            { hpPct: 0.25, name: 'Womb Curse Sovereign (Final Phase)', effect: 'domain', desc: 'The sovereign expands its domain! Sure-hit damage incoming!' }
        ],
        rewards: { xp: 300, gold: 200, minRarity: 'rare' }
    },
    {
        id: 2, name: 'Shinjuku Server Farm', minLevel: 5, floors: 5, ce_cost: 30,
        desc: 'Corrupted data has spawned digital curses in Akihabara\'s server farms.',
        enemies: ['Cursed Spirit', 'Cursed Womb', 'Sorcerer Killer', 'Disaster Curse', 'Special Grade Entity'],
        boss: 'Data Corruption Entity',
        bossPhases: [
            { hpPct: 0.66, name: 'Data Corruption Entity (Corrupted)', effect: 'glitch', desc: 'The entity glitches — its attacks become unpredictable!' },
            { hpPct: 0.33, name: 'Data Corruption Entity (System Failure)', effect: 'enrage', desc: 'System failure! The entity\'s damage is doubled!' }
        ],
        rewards: { xp: 500, gold: 350, minRarity: 'epic' }
    },
    {
        id: 3, name: 'Shibuya Curtain Zone', minLevel: 10, floors: 6, ce_cost: 40,
        desc: 'A cursed curtain has trapped civilians. The enemy inside grows stronger by the minute.',
        enemies: ['Vengeful Spirit', 'Accursed Corpse', 'Sorcerer Killer', 'Disaster Curse', 'Special Grade Entity'],
        boss: 'Curtain Warden',
        bossPhases: [
            { hpPct: 0.75, name: 'Curtain Warden (Desperate)', effect: 'blind', desc: 'The warden releases a blinding flash! You are blinded for 1 turn!' },
            { hpPct: 0.5, name: 'Curtain Warden (Frenzied)', effect: 'enrage', desc: 'The warden frenzies — attacks hit 2x harder!' },
            { hpPct: 0.25, name: 'Curtain Warden (Last Stand)', effect: 'domain', desc: 'The warden expands a shrinking domain! Sure-hit damage!' }
        ],
        rewards: { xp: 800, gold: 600, minRarity: 'epic' }
    },
    {
        id: 4, name: 'Yokohama Cargo Ship', minLevel: 15, floors: 7, ce_cost: 50,
        desc: 'A special-grade curse has commandeered a cargo ship. The cargo holds unknown horrors.',
        enemies: ['Accursed Corpse', 'Disaster Curse', 'Special Grade Entity', 'Divine Dog', 'Finger Bearer'],
        boss: 'Cargo Horror',
        bossPhases: [
            { hpPct: 0.66, name: 'Cargo Horror (Awakened)', effect: 'enrage', desc: 'The horror awakens — damage increased 50%!' },
            { hpPct: 0.33, name: 'Cargo Horror (Corpse Tide)', effect: 'summon', desc: 'The horror floods the deck with cursed corpses! 3 minions appear!' }
        ],
        rewards: { xp: 1200, gold: 900, minRarity: 'legendary' }
    },
    {
        id: 5, name: 'Sukuna\'s Prison Realm', minLevel: 20, floors: 10, ce_cost: 80,
        desc: 'A rift into a cursed realm. Only the strongest dare enter. Legendary artifacts await.',
        enemies: ['Disaster Curse', 'Special Grade Entity', 'Divine Dog', 'Finger Bearer', 'Special Grade Entity'],
        boss: 'Ryomen Sukuna Fragment',
        bossPhases: [
            { hpPct: 0.85, name: 'Sukuna Fragment (Cleave)', effect: 'cleave', desc: 'Sukuna readies Cleave — next hit bypasses 50% defense!' },
            { hpPct: 0.65, name: 'Sukuna Fragment (Dismantle)', effect: 'multi', desc: 'Sukuna unleashes Dismantle — rapid slashes deal 5x hits!' },
            { hpPct: 0.45, name: 'Sukuna Fragment (Malevolent Shrine)', effect: 'domain', desc: 'Malevolent Shrine activated! Sure-hit 3400 damage to all!' },
            { hpPct: 0.25, name: 'Sukuna Fragment (Full Power)', effect: 'enrage', desc: 'Sukuna goes all out — damage tripled!' }
        ],
        rewards: { xp: 2500, gold: 2000, minRarity: 'artifact' }
    }
];

const GUILD_RANKS = [
    { name: 'Member', permissions: ['quest', 'chat', 'donate'] },
    { name: 'Officer', permissions: ['quest', 'chat', 'donate', 'invite', 'kick'] },
    { name: 'Leader', permissions: ['*'] }
];

// ── Clan system ──
const CLAN_CREATE_COST = 2000000000;          // 2,000,000,000 coins to found a clan
const CLAN_MAINTENANCE_COST = 100000000;      // 100,000,000 coins every cycle
const CLAN_MAINTENANCE_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLAN_MAX_MEMBERS = 50;

function normClanName(name) {
    return String(name || '').trim().toLowerCase();
}

function findClanByName(name) {
    if (!db.clans) return null;
    return db.clans[normClanName(name)] || null;
}

function clanMemberTitle(headName) {
    return `Protection from ${headName}`;
}

// Deduct maintenance from clan heads, allowing wallets to go negative (debt).
function processClanMaintenance() {
    if (!db.clans) return;
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(db.clans)) {
        const clan = db.clans[key];
        if (!clan.next_maintenance) {
            clan.next_maintenance = (clan.created_at || now) + CLAN_MAINTENANCE_INTERVAL;
            changed = true;
        }
        while (now >= clan.next_maintenance) {
            const head = db.users[clan.head];
            if (head) head.wallet = (head.wallet || 0) - CLAN_MAINTENANCE_COST;
            clan.next_maintenance += CLAN_MAINTENANCE_INTERVAL;
            changed = true;
        }
        const head = db.users[clan.head];
        const bal = head ? (head.wallet || 0) : 0;
        const newDebt = bal < 0 ? Math.abs(bal) : 0;
        if (clan.debt !== newDebt) { clan.debt = newDebt; changed = true; }
    }
    processVillageTaxes();
    if (changed) saveDb();
}

function getPoorestClan() {
    if (!db.clans) return null;
    let poorest = null, min = Infinity;
    for (const key of Object.keys(db.clans)) {
        const clan = db.clans[key];
        const head = db.users[clan.head];
        const bal = head ? (head.wallet || 0) : 0;
        if (bal < min) { min = bal; poorest = clan; }
    }
    return poorest;
}

// ── Villages & clan colonisation ──
// 500 villages seeded with flower names. A clan may colonise ONE village, set a daily tax
// that flows into the clan head's wallet, and if that daily tax exceeds 13,000,000 the
// villagers rebel and post a liberation mission any player can accept with .v-a.
const FLOWER_NAMES = [
    'Rose', 'Lily', 'Tulip', 'Daisy', 'Sunflower', 'Orchid', 'Jasmine', 'Lotus', 'Marigold', 'Lavender',
    'Violet', 'Poppy', 'Daffodil', 'Iris', 'Carnation', 'Peony', 'Dahlia', 'Azalea', 'Begonia', 'Chrysanthemum',
    'Camellia', 'Gardenia', 'Hibiscus', 'Magnolia', 'Narcissus', 'Pansy', 'Petunia', 'Primrose', 'Snapdragon', 'Wisteria',
    'Zinnia', 'Aster', 'Bluebell', 'Buttercup', 'Crocus', 'Freesia', 'Geranium', 'Hyacinth', 'Ixia', 'Jonquil',
    'Lilac', 'Mimosa', 'Nasturtium', 'Oleander', 'Periwinkle', 'Quince', 'Ranunculus', 'Snowdrop', 'Sweet Pea', 'Foxglove',
    'Anemone', 'Amaryllis', 'Bachelor Button', 'Bellflower', 'Birds of Paradise', 'Black-Eyed Susan', 'Bleeding Heart', 'Calla Lily', 'Canna', 'Clematis',
    'Columbine', 'Coreopsis', 'Cosmos', 'Cowslip', 'Cyclamen', 'Delphinium', 'Dianthus', 'Echinacea', 'Fuchsia', 'Gazania',
    'Gladiolus', 'Honeysuckle', 'Impatiens', 'Jacaranda', 'Johnny Jump Up', 'Lantana', 'Lupine', 'Morning Glory', 'Nemesia', 'Nigella',
    'Osteospermum', 'Phlox', 'Plumeria', 'Salvia', 'Statice', 'Stock', 'Thunbergia', 'Verbena', 'Veronica', 'Wallflower',
    'Yarrow', 'Aconite', 'Agapanthus', 'Allium', 'Alstroemeria', 'Aubrieta', 'Bergenia', 'Broom', 'Candytuft', 'Catmint',
    'Cineraria', 'Clarkia', 'Crape Myrtle', "Dame's Rocket", 'Daylily', 'Eustoma', 'Flax', 'Forget-Me-Not', 'Gaillardia', 'Geum'
];

function rollVillageStats() {
    const population = 500 + Math.floor(Math.random() * 49500); // 500 - 50,000
    const wealth = 100000 + Math.floor(Math.random() * 60000000); // 100k - 60M K-Coins
    return { population, wealth };
}

function villageWealthTier(wealth) {
    if (wealth >= 50000000) return '💎 Prosperous';
    if (wealth >= 15000000) return '🪙 Wealthy';
    if (wealth >= 3000000) return '🪙 Modest';
    return '🥺 Poor';
}

function ensureVillages() {
    if (!db.villages) db.villages = {};
    if (Object.keys(db.villages).length >= 500) return;
    let n = Object.keys(db.villages).length;
    const used = new Set(Object.values(db.villages).map(v => v.name.toLowerCase()));
    while (n < 500) {
        const base = FLOWER_NAMES[n % FLOWER_NAMES.length];
        let suffix = Math.floor(n / FLOWER_NAMES.length) + 1;
        let name = suffix > 1 ? `${base} ${suffix}` : base;
        while (used.has(name.toLowerCase())) { suffix++; name = `${base} ${suffix}`; }
        used.add(name.toLowerCase());
        const id = 'vlg_' + (n + 1);
        const stats = rollVillageStats();
        db.villages[id] = { id, name, population: stats.population, wealth: stats.wealth, colonisedBy: null, coloniserClanName: null, tax: 0, dailyTax: 0, lastTaxDay: Date.now(), rebellion: false, mission: null };
        n++;
    }
    saveDb();
}

function migrateDomains() {
    if (!db.users) return;
    for (const u of Object.values(db.users)) {
        if ((u.grade ?? 4) <= 2) {
            u.unlocked_features = u.unlocked_features || {};
            u.unlocked_features.Domain = true;
        }
    }
}

// Backfill population/wealth onto villages seeded before those fields existed.
function migrateVillages() {
    if (!db.villages) return;
    let changed = false;
    for (const v of Object.values(db.villages)) {
        if (typeof v.population !== 'number') { v.population = rollVillageStats().population; changed = true; }
        if (typeof v.wealth !== 'number') { v.wealth = rollVillageStats().wealth; changed = true; }
    }
    if (changed) saveDb();
}

// V2 Clan migration: add new fields to existing clans
function migrateClans() {
    if (!db.clans) return;
    let changed = false;
    for (const clan of Object.values(db.clans)) {
        if (typeof clan.level !== 'number') { clan.level = 1; changed = true; }
        if (typeof clan.xp !== 'number') { clan.xp = 0; changed = true; }
        if (typeof clan.bank !== 'number') { clan.bank = 0; changed = true; }
        if (!Array.isArray(clan.buffs)) { clan.buffs = []; changed = true; }
        if (!Array.isArray(clan.missions)) { clan.missions = []; changed = true; }
        if (!clan.wars) { clan.wars = {}; changed = true; }
        if (!clan.boss) { clan.boss = null; changed = true; }
    }
    if (changed) saveDb();
}

// Retroactively scale HP/CE for existing users based on their level.
// New formula: Max_HP doubles per level, Max_CE doubles per level.
function migrateLevelScaling() {
    if (!db.users) return;
    let changed = false;
    for (const u of Object.values(db.users)) {
        if (!u.stats) continue;
        const level = u.level || 1;
        const baseHP = 120;
        const baseCE = 100;
        const expectedHP = Math.max(1, baseHP + (level - 1) * 10);
        const expectedCE = Math.max(1, baseCE + (level - 1) * 5);
        if (u.loots?.includes('limitless_six_eyes')) {
            if (u.stats.Max_CE !== Infinity) { u.stats.Max_CE = Infinity; u.stats.CE = Infinity; changed = true; }
        } else {
            if (u.stats.Max_HP !== expectedHP) { u.stats.Max_HP = expectedHP; changed = true; }
            if (u.stats.Max_CE !== expectedCE) { u.stats.Max_CE = expectedCE; changed = true; }
        }
        u.stats.HP = Math.min(u.stats.HP || 1, u.stats.Max_HP);
        u.stats.CE = Math.min(u.stats.CE || 0, u.stats.Max_CE);
    }
    if (changed) saveDb();
}

// Trim any user who somehow holds more than one loot down to a single loot.
function migrateSingleLoot() {
    if (!db.users) return;
    let changed = false;
    for (const u of Object.values(db.users)) {
        if (u.loots && u.loots.length > 1) {
            const keep = u.loots[u.loots.length - 1];
            revertLootEffects(u);
            u.loots = [keep];
            applyLootEffects(u);
            changed = true;
        }
    }
    if (changed) saveDb();
}

function migrateHrSummons() {
    if (!db.users) return;
    let changed = false;
    for (const u of Object.values(db.users)) {
        if (u.heavenly_restriction && u.ownedSummons && u.ownedSummons.length) {
            for (const sid of u.ownedSummons) releaseSummonToShop(u, sid);
            u.ownedSummons = [];
            u.summon = { active: false, name: 'None', HP: 0, Max_HP: 0, CE: 0, Max_CE: 0, atk: 0, move: null, effect: null, pl: 0 };
            changed = true;
        }
    }
    if (changed) saveDb();
}

function migrateLimitlessTechniques() {
    if (!db.users) return;
    let changed = false;
    for (const u of Object.values(db.users)) {
        if (u.loots && u.loots.includes('limitless_six_eyes') && u.innate_technique_id !== 'Limitless') {
            u.innate_technique_id = 'Limitless';
            u.technique_1 = 'blue';
            u.technique_2 = 'red';
            u.technique_3 = 'purple';
            u.technique_4 = u.technique_4 || null;
            u.skills = INNATE_TECHNIQUES['Limitless']?.moves || u.skills;
            changed = true;
        }
    }
    if (changed) saveDb();
}

// V2 Migration: adds all new V2 fields with safe defaults without overwriting existing data.
function migrateV2() {
    if (!db.users) return;
    let changed = false;
    for (const u of Object.values(db.users)) {
        // Technique Mastery
        if (!u.technique_mastery) { u.technique_mastery = {}; changed = true; }
        if (!u.technique_stats) { u.technique_stats = {}; changed = true; }
        
        // Weapon Mastery
        if (!u.weapon_mastery) { u.weapon_mastery = {}; changed = true; }
        
        // Prestige
        if (typeof u.prestige !== 'number') { u.prestige = 0; changed = true; }
        if (typeof u.prestige_points !== 'number') { u.prestige_points = 0; changed = true; }
        
        // Statistics
        if (!u.statistics) {
            u.statistics = {
                curses_defeated: 0,
                pvp_wins: 0,
                pvp_losses: 0,
                dungeons_cleared: 0,
                techniques_used: 0,
                domains_expanded: 0,
                total_damage_dealt: 0,
                total_damage_taken: 0,
                critical_hits: 0,
                perfect_guards: 0
            };
            changed = true;
        }
        
        // Daily Missions
        if (!u.daily_missions) {
            u.daily_missions = { date: null, missions: [], claimed: false };
            changed = true;
        }
        
        // Collections
        if (!u.collections) {
            u.collections = { curses: [], weapons: [], armor: [], summons: [] };
            changed = true;
        }
        
        // Cooldowns
        if (!u.cooldowns) { u.cooldowns = {}; changed = true; }
        if (!u.combat_cooldowns) { u.combat_cooldowns = {}; changed = true; }
        
        // Clan contributions
        if (!u.clan_contributions) {
            u.clan_contributions = { total_donated: 0, missions_completed: 0 };
            changed = true;
        }
        
        // Crafting
        if (!u.crafting) {
            u.crafting = { recipes: [], materials: {} };
            changed = true;
        }
        
        // Stance Mastery
        if (typeof u.stance_mastery !== 'number') { u.stance_mastery = 0; changed = true; }
        
        // Domain Mastery
        if (typeof u.domain_mastery !== 'number') { u.domain_mastery = 0; changed = true; }
        if (typeof u.domain_kills !== 'number') { u.domain_kills = 0; changed = true; }
        
        // Boss encounters
        if (!u.boss_encounters) { u.boss_encounters = {}; changed = true; }
        
        // Skill tree path
        if (!u.skill_tree_path) { u.skill_tree_path = []; changed = true; }
        if (!u.skill_tree_points) { u.skill_tree_points = 0; changed = true; }
    }
    
    // Top-level DB fields
    if (!db.clan_wars) { db.clan_wars = {}; changed = true; }
    if (!db.global_events) { db.global_events = { last_daily_reset: 0, last_weekly_reset: 0, seasonal_start: Date.now() }; changed = true; }
    if (!db.crafting_recipes) { db.crafting_recipes = {}; changed = true; }
    if (!db.bosses) { db.bosses = {}; changed = true; }
    if (!db.trade_offers) { db.trade_offers = {}; changed = true; }
    
    if (changed) saveDb();
}

// Seed villages + unlock Domain for anyone already at Grade 2+. Called once on bot boot.
function initWorld() {
    ensureVillages();
    migrateVillages();
    migrateDomains();
    migrateSingleLoot();
    migrateLevelScaling();
    migrateHrSummons();
    migrateLimitlessTechniques();
    migrateV2();
    migrateClans();
}

function findVillageByName(name) {
    if (!name || !db.villages) return null;
    const s = String(name).toLowerCase().trim();
    return Object.values(db.villages).find(v => v.name.toLowerCase() === s) || null;
}

function findClanVillage(clan) {
    if (!clan || !db.villages) return null;
    const key = normClanName(clan.name);
    return Object.values(db.villages).find(v => v.colonisedBy === key) || null;
}

function startVillageRebellion(village) {
    village.rebellion = true;
    village.mission = { active: true, acceptedBy: null };
    broadcastNow(`🔥 *VILLAGERS OF ${village.name.toUpperCase()} HAVE RISEN!*\nA clan crushes them with taxes above 13,000,000/day.\nA LIBERATION MISSION is open — use *.v-a* to accept, then defeat the clan head in a 1v1 to free the villagers!`);
}

// Collects daily taxes into the colonising clan head's wallet and triggers a rebellion
// if a single day's tax intake exceeds 13,000,000.
function processVillageTaxes() {
    if (!db.villages) return;
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    let changed = false;
    for (const v of Object.values(db.villages)) {
        if (!v.colonisedBy) { v.dailyTax = 0; continue; }
        const clan = findClanByName(v.coloniserClanName);
        if (!clan) {
            // Colonising clan was disbanded — free the village.
            v.colonisedBy = null; v.coloniserClanName = null; v.tax = 0; v.rebellion = false; v.mission = null; v.dailyTax = 0;
            changed = true; continue;
        }
        if (!v.lastTaxDay) v.lastTaxDay = now;
        while (now - v.lastTaxDay >= DAY) {
            const clan = findClanByName(v.coloniserClanName);
            const head = clan && db.users[clan.head];
            v.lastTaxDay += DAY;
            if (head && v.tax > 0) {
                head.wallet = (head.wallet || 0) + v.tax;
                v.dailyTax += v.tax;
            }
            if (v.dailyTax > 13000000 && !v.rebellion) startVillageRebellion(v);
            v.dailyTax = 0; // reset for the new day
            changed = true;
        }
    }
    if (changed) saveDb();
}

let clanMaintenanceTimer = null;
let worldTimer = null;

function getRandomTechnique(type) {
    const techniques = type === 'Curse' ? CURSE_NAMES : FIGHTER_NAMES;
    return techniques[Math.floor(Math.random() * techniques.length)];
}

function roll(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function getEffectiveGrade(user) {
    const g = user.grade ?? 4;
    const l = user.level ?? 1;
    return clamp(g - Math.floor(l / 10), 0, 4);
}

// Random/dungeon curses scale by tracking the player's tier: as the player grows,
// the encounter's effective grade rises (number drops) and its stats come from the
// same CURSE_GRADE_STATS table, keeping difficulty paired with player power and bounded.
function scaleEnemy(baseGrade, playerLevel) {
    const g = clamp(baseGrade - Math.floor(playerLevel / 25), 0, 4);
    const base = CURSE_GRADE_STATS[g];
    const hp = Math.floor(base.hp * roll(0.9, 1.15));
    const ce = Math.floor(base.ce * roll(0.9, 1.15));
    const atk = Math.floor(base.atk * roll(0.9, 1.15));
    return { grade: g, stats: { HP: hp, Max_HP: hp, CE: ce, Max_CE: ce, Output: 1, Refinement: 10 }, atk };
}

// Grade-based curse combat stats. Lower grade number = stronger.
// Tuned to be an *even* fight at each grade: a curse lasts roughly 6-10 basic hits and
// hits hard enough to be a genuine threat, but is winnable with techniques, summons and RCT.
const CURSE_GRADE_STATS = {
    0: { hp: 4200, atk: 245, ce: 280 },  // Special Grade
    1: { hp: 2050, atk: 130, ce: 200 },   // Grade 1
    2: { hp: 1150, atk: 80,  ce: 160 },    // Grade 2
    3: { hp: 860,  atk: 62,  ce: 130 },     // Grade 3 — a real threat that challenges Grade 3 sorcerers
    4: { hp: 430,  atk: 36,  ce: 100 }      // Grade 4 — stronger than before, a genuine challenge for Grade 4 sorcerers
};

// ── WORLD: Villages, Clans, Missions, Corruption & THE CULLT ──
const EVIL_CLAN_NAMES = ['The Hollow Syndicate','Crimson Pact','Ashen Order','Veiled Fang','Maw of Greed','Sable Dominion'];
const CULT_MEMBERS = [
    { id:'urahime', name:'URAHIME', title:'High Priestess of the Cullt', ct:'Ice Technique', special:true, leader:true, grade:0 },
    { id:'ifechukwu', name:'Ifechukwu', title:'Flame God Apostle', ct:'Flame God Technique', special:true, strongerThanLeader:true, grade:0 },
    { id:'daki', name:'Daki', title:'Blood Apostle', ct:'Blood Technique', special:true, grade:1 },
    { id:'nax', name:'Nax', title:'Shadow Apostle', ct:'Shadow Technique', special:true, grade:1 },
    { id:'hori', name:'Hori', title:'Earth Apostle', ct:'Earth Technique', special:true, grade:1 },
    { id:'nore', name:'Nore', title:'Darkness Apostle', ct:'Darkness Technique', special:true, grade:1 }
];
const SORCERER_NPCS = [
    { id:'megumi', name:'Megumi Fushiguro', title:'Ten Shadows Sorcerer', ct:'Ten Shadows Technique', grade:1 },
    { id:'nobara', name:'Nobara Kugisaki', title:'Straw Doll Master', ct:'Straw Doll Technique', grade:3 },
    { id:'panda', name:'Panda', title:'Abnormal Mutant', ct:'Alchemical Armament', grade:2 },
    { id:'maki', name:'Maki Zenin', title:'Zenin Weapon Master', grade:2 },
    { id:'todo', name:'Todo', title:'Cursed Energy Prodigy', ct:'Boogie Woogie', grade:1 },
    { id:'yuta', name:'Yuta Okkotsu', title:'Special Grade Sorcerer', ct:'Copy', grade:0 },
    { id:'nanami', name:'Nanami Kento', title:'Grade 1 Sorcerer', ct:'Ratio Technique', grade:1 },
    { id:'akari', name:'Akari', title:'Heavenly Restriction', grade:3 },
    { id:'kenjaku', name:'Kenjaku', title:'Culling Game Mastermind', ct:'Brain Transplantation', grade:0 }
];
const CULT_GRUNT_NAMES = ['Cult Acolyte','Hooded Zealot','Sukuna Drone','Masked Follower','Veiled Thrall'];

function ensureWorld() {
    db.cullt = db.cullt || { active:true, hunted:{}, lastHunt:0 };
    db.npcClans = db.npcClans || {};
    db.villages = db.villages || {};
    db.sorcererNpcs = db.sorcererNpcs || { active: {}, patrols: {} };
    for (const [id, v] of Object.entries(db.villages)) {
        v.mission = v.mission || null;
        v.population = v.population || 1000;
        v.wealth = v.wealth || 100000;
        v.clan = v.clan || null;
        v.rebellion = v.rebellion || false;
        v.liberated = v.liberated || 0;
    }
    generateVillageMissions(true);
    spawnSorcererNpcs();
}

function spawnSorcererNpcs() {
    const npcs = db.sorcererNpcs || {};
    if (Object.keys(npcs.active).length > 0) return;
    const count = 3 + Math.floor(Math.random() * 5);
    const pool = [...SORCERER_NPCS];
    for (let i = 0; i < count && pool.length > 0; i++) {
        const npc = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        const villages = Object.values(db.villages || {});
        if (villages.length === 0) break;
        const village = pick(villages);
        npcs.active[npc.id] = {
            ...npc,
            villageId: village.id,
            villageName: village.name,
            status: 'patrolling',
            ally: null,
            spawnedAt: Date.now()
        };
    }
    db.sorcererNpcs = npcs;
}

function getRandomSorcererNpc() {
    const npcs = db.sorcererNpcs?.active || {};
    const entries = Object.entries(npcs).filter(([id, n]) => n.status === 'patrolling');
    if (entries.length === 0) return null;
    const [id, npc] = pick(entries);
    return { id, ...npc };
}

function tagTeamNpc(user, npcId) {
    const npcs = db.sorcererNpcs || {};
    const npc = npcs.active?.[npcId];
    if (!npc) return null;
    npc.ally = user.player_id;
    npc.status = 'tag_team';
    db.sorcererNpcs = npcs;
    return npc;
}

function releaseTagTeamNpc(npcId) {
    const npcs = db.sorcererNpcs || {};
    const npc = npcs.active?.[npcId];
    if (npc) {
        npc.ally = null;
        npc.status = 'patrolling';
        npc.villageId = Object.keys(db.villages || {})[Math.floor(Math.random() * Object.keys(db.villages || {}).length)] || null;
        db.sorcererNpcs = npcs;
    }
}

function generateVillageMissions(seedOnly) {
    let count = 0;
    const titles = ['Drive out the traffickers','Rescue the taken villagers','Slay the clan enforcer','Break the clan\'s grip','Protect the caravan'];
    const missionClasses = [
        { class: 'SSS', minLevel: 150, danger: 5, rewardGold: 500_000, rewardXp: 500_000, enemyGrade: 0, enemyMult: 4.0, desc: 'A catastrophic threat on the level of Urahime and the Kings of Pandora looms over the village. Only the strongest sorcerers can hope to survive.' },
        { class: 'SS', minLevel: 70, danger: 4, rewardGold: 500_000, rewardXp: 100_000, enemyGrade: 1, enemyMult: 2.5, desc: 'The five knights of the cult have descended upon the village. Their power is unlike any ordinary threat.' },
        { class: 'S', minLevel: 30, danger: 3, rewardGold: 500_000, rewardXp: 60_000, enemyGrade: 2, enemyMult: 1.8, desc: 'A special-grade curse has taken root in the village. It requires a skilled sorcerer to purge.' },
        { class: 'A', minLevel: 10, danger: 2, rewardGold: 500_000, rewardXp: 20_000, enemyGrade: 3, enemyMult: 1.2, desc: 'A grade-1 curse menaces the villagers. Brave sorcerers are needed to drive it back.' },
        { class: 'B', minLevel: 1, danger: 2, rewardGold: 500_000, rewardXp: 10_000, enemyGrade: 3, enemyMult: 1.0, desc: 'A hostile curse lurks near the village. The villagers need protection.' },
        { class: 'C', minLevel: 1, danger: 1, rewardGold: 500_000, rewardXp: 5_000, enemyGrade: 4, enemyMult: 0.8, desc: 'Low-level curses are harassing the village. A quick intervention is needed.' },
        { class: 'D', minLevel: 1, danger: 1, rewardGold: 500_000, rewardXp: 2_000, enemyGrade: 4, enemyMult: 0.6, desc: 'Minor cursed spirits have been spotted. The village watch can handle it with some help.' },
        { class: 'E', minLevel: 1, danger: 0, rewardGold: 500_000, rewardXp: 1_000, enemyGrade: 4, enemyMult: 0.4, desc: 'A trivial annoyance. The village requests a capable hand to deal with it.' }
    ];
    const weights = [5, 5, 10, 20, 30, 20, 10, 10];
    for (const [id, v] of Object.entries(db.villages)) {
        if (v.mission) continue;
        if (seedOnly && count >= 3) break;
        if (Math.random() < (seedOnly ? 0.6 : 0.22)) {
            const clan = v.clan || v.coloniserClanName || pick(EVIL_CLAN_NAMES);
            const missionClass = pickWeighted(missionClasses, weights);
            v.mission = {
                title: pick(titles),
                clan,
                class: missionClass.class,
                danger: missionClass.danger,
                reward: missionClass.rewardGold,
                rewardXp: missionClass.rewardXp,
                enemyGrade: missionClass.enemyGrade,
                enemyMult: missionClass.enemyMult,
                desc: `Clan "${clan}" has been oppressing ${v.name} — trafficking villagers and extorting wealth. Villagers beg for a sorcerer to intervene. ${missionClass.desc}`
            };
            count++;
        }
    }
}

function pickWeighted(items, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
    }
    return items[items.length - 1];
}

function buildNpcEnemy(member, user) {
    const lvl = user.level || 1;
    let base, mult = 1;
    if (member.id === 'urahime') { base = CURSE_GRADE_STATS[0]; mult = 1.0; }
    else if (member.id === 'ifechukwu') { base = CURSE_GRADE_STATS[0]; mult = 1.25; }
    else if (member.special) { base = CURSE_GRADE_STATS[1]; mult = 1.0; }
    else { base = { hp: Math.floor(CURSE_GRADE_STATS[4].hp * 0.75), atk: Math.floor(CURSE_GRADE_STATS[4].atk * 0.8), ce: CURSE_GRADE_STATS[4].ce }; mult = 1; }
    const scale = 1 + (lvl - 1) * 0.04;
    const corr = 1 + Math.min(0.3, (user.corruption || 0) / 200);
    const hp = Math.max(60, Math.floor(base.hp * mult * scale));
    const atk = Math.max(8, Math.floor(base.atk * mult * scale * corr));
    const ce = base.ce;
    return {
        name: member.name,
        grade: member.grade ?? 4,
        stats: { HP: hp, Max_HP: hp, CE: ce, Max_CE: ce, Output: 1, Refinement: 10 },
        atk,
        originalMaxHP: hp,
        technique: member.ct || 'Cult Arts',
        canDomain: !!member.special,
        domainChance: member.special ? 0.18 : 0.04,
        skills: {},
        comboChance: member.special ? 0.30 : 0.10,
        memberId: member.id,
        isCult: true
    };
}

function pickCultMember() {
    if (Math.random() < 0.10) {
        const specials = CULT_MEMBERS.filter(m => m.special);
        const urahime = specials.find(m => m.id === 'urahime');
        const pool = Math.random() < 0.04 ? (urahime ? [urahime] : []) : specials;
        if (pool.length) return pick(pool);
    }
    return { id:'grunt', name: pick(CULT_GRUNT_NAMES), title:'Cult Grunt', special:false, grade:4 };
}

function cultIntro(member, user) {
    const hero = user.name || 'sorcerer';
    return `☠️ *THE CULLT — AMBUSH*\n\n*${member.name}* (${member.title}):\n"Sukuna-sama... the greatest Sorcerer of that era sealed sukuna away. That sorcerer's name was *Benimaru*, the strongest sorcerer in History. And we shall kill him."\n\n"We are worshippers of the King of Curses. Hand over the fingers, ${hero}."`;
}

async function startCultAmbush(sock, jid, user, announce) {
    if (db.combats[jid]) return false;
    const member = pickCultMember();
    const enemy = buildNpcEnemy(member, user);
    db.combats[jid] = {
        player: user,
        enemy,
        round: 1,
        cultFight: true,
        missionFight: false,
        memberId: member.id,
        villageId: null,
        playerStatus: [],
        enemyIntent: pickEnemyMove(),
        enemyGuarding: false,
        guarding: false,
        host: jid,
        participants: [jid]
    };
    saveDb();
    if (announce && sock) {
        broadcastAllGroups(sock, `☠️ THE CULLT has located *${user.name || jid}* who harbors Sukuna's fingers! Worshippers ambush in av1 — all groups on alert!`);
        try { await sock.sendMessage(jid, { text: `${cultIntro(member, user)}\n\n⚔️ *${enemy.name}* steps forward (HP ${enemy.stats.Max_HP} | ATK ${enemy.atk}).\n───\n*Type .attack to defend!*\n👁️ Intent: ${enemyIntentHint(db.combats[jid].enemyIntent)}`, mentions: [jid] }); } catch {}
    }
    return true;
}

async function handleNpcFight(sock, from, sender, user, command, args) {
    const combat = db.combats[sender];
    if (!combat) return;
    const enemy = combat.enemy;
    const heroName = user.name || sender.split('@')[0];
    if (combat.playerDomainBurnout > 0 && !['attack','guard','flee','rct'].includes(command)) {
        await sock.sendMessage(from, { text: '🔥 CE BURNOUT: You can only use .attack, .guard, .flee, .rct for now.', mentions: [sender] });
        return;
    }
    const bleedLines = tickCombatStatus(combat, user);
    if (user.stats.HP <= 0) {
        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
        user.corruption = Math.min(100, (user.corruption || 0) + 8);
        saveDb();
        await sock.sendMessage(from, { text: `💀 The enemy overwhelms you.\nCorruption +8.\n${r}`, mentions: [sender] });
        return;
    }
    
    // Hallucination system: sanity < 40% can cause random actions
    if (combat.hallucination && Math.random() < 0.35) {
        const hallucinationMessages = [
            '👁️ HALLUCINATION: You attack a phantom enemy that doesn\'t exist!',
            '👁️ HALLUCINATION: Your technique fizzles into thin air!',
            '👁️ HALLUCINATION: You see double — which one is the real enemy?',
            '😵 HALLUCINATION: Dizziness overcomes you. You stumble and miss your turn!'
        ];
        const hallMsg = hallucinationMessages[Math.floor(Math.random() * hallucinationMessages.length)];
        combat.hallucination = false;
        await sock.sendMessage(from, { text: hallMsg, mentions: [sender] });
        combat.round++;
        combat.enemyIntent = pickEnemyMove();
        saveDb();
        const phase = runEnemyPhase(combat, user);
        if (phase.dead) {
            const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
            if (r === 'ended' || r === 'knocked') return;
        }
        return;
    }
    
    let dmg = 0, isCrit = false, isDodge = false, techDisplayName = '', techEffects = [], ceCost = 0;
    let playerDmgMult = 1;

    if (command === 'flee') {
        user.title = 'Loser';
        user.loser_until = Date.now() + 72 * 60 * 60 * 1000;
        endCombatKeys(combat);
        saveDb();
        await sock.sendMessage(from, { text: `🏃 *FLEE SUCCESSFUL*\n───\nTitle acquired: *Loser* (72h)\nThe mission is abandoned.`, mentions: [sender] });
        return;
    } else if (command === 'guard') {
        user.stats.CE = Math.min(user.stats.Max_CE, user.stats.CE + 15);
        combat.guarding = true;
    } else if (command === 'move') {
        const dist = combat.distance || 5;
        const dir = (args[0] || '').toLowerCase();
        let newDist = dist;
        if (dir === 'close' || dir === 'c' || dir === 'in') newDist = Math.max(1, dist - 5);
        else if (dir === 'far' || dir === 'f' || dir === 'out') newDist = Math.min(50, dist + 5);
        else if (dir === 'melee' || dir === 'm') newDist = 2;
        else if (dir === 'range' || dir === 'r') newDist = 15;
        else if (!isNaN(parseInt(dir))) newDist = Math.max(1, Math.min(50, parseInt(dir)));
        else { await sock.sendMessage(from, { text: `📏 Current distance: ${dist}m\nUsage: .move <close|far|melee|range|number>`, mentions: [sender] }); return; }
        combat.distance = newDist;
        saveDb();
        await sock.sendMessage(from, { text: `📏 Distance adjusted to *${newDist}m*`, mentions: [sender] });
        return;
    } else if (command === 'rct') {
        if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You have no cursed energy — RCT is impossible.', mentions: [sender] }); return; }
        const val = Math.max(1, parseInt(args[0]) || Math.floor(user.stats.Max_HP * 0.3));
        const ceSpend = Math.max(1, Math.ceil(val / 2));
        if (user.stats.CE < ceSpend) {
            await sock.sendMessage(from, { text: `[⚠️ INSUFFICIENT CE: RCT NEEDS ${ceSpend}]`, mentions: [sender] });
            return;
        }
        user.stats.CE -= ceSpend;
        user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + val);
        techDisplayName = 'RCT Heal';
        techEffects = [`Restored ${val} HP`];
     } else if (command === 'heal') {
         if (!user) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); return; }
         const fishCount = (user.inventory || []).filter(i => i.name === 'Fish').length;
         const summonNeedsHeal = user.summon?.active && user.summon.HP < user.summon.Max_HP;
         const fishNeeded = summonNeedsHeal ? 2 : 1;
         if (fishCount < fishNeeded) {
             const msg = summonNeedsHeal
                 ? `🐟 *NEED 2 FISH!* You have ${fishCount} fish. Your summon also needs healing — `.heal` costs 2 fish.`
                 : `🐟 *NO FISH!* You need a Fish in your inventory to heal. Use .fish to catch one.`;
             await sock.sendMessage(from, { text: msg, mentions: [sender] }); return;
         }
         const now = Date.now();
         const last = user.last_heal || 0;
         const cooldown = 60 * 1000;
         if (now - last < cooldown) {
             const remaining = Math.ceil((cooldown - (now - last)) / 1000);
             await sock.sendMessage(from, { text: `💊 *HEAL COOLDOWN*\nWait ${remaining}s.`, mentions: [sender] });
             return;
         }
         user.last_heal = now;
         user.inventory = (user.inventory || []).filter(i => i.name !== 'Fish');
         user.stats.HP = user.stats.Max_HP;
         user.stats.CE = user.stats.Max_CE;
         if (summonNeedsHeal && user.summon) {
             user.summon.HP = user.summon.Max_HP;
         }
         clearDoTStatuses(user, combat);
         saveDb();
         const healMsg = summonNeedsHeal
             ? `🐟 *ATE 2 FISH & HEALED*\n${user.name || sender.split('@')[0]} restored to *${user.stats.Max_HP} HP* | *${user.stats.Max_CE} CE*.\n🐾 Summon also fully healed!`
             : `🐟 *ATE FISH & HEALED*\n${user.name || sender.split('@')[0]} restored to *${user.stats.Max_HP} HP* | *${user.stats.Max_CE} CE*.`;
         await sock.sendMessage(from, { text: healMsg, mentions: [sender] });
         return;
      } else if (command === 'domain') {
         if (user.heavenly_restriction) {
             await sock.sendMessage(from, { text: '⛓️ *HEAVENLY RESTRICTION:* Domains cannot work on your body. You are immune to Domain Expansion.', mentions: [sender] });
             return;
         }
         const canDomain = user.domain_unlocked || user.unlocked_features?.Domain || user.loots?.includes('limitless_six_eyes');
        if (!canDomain) {
            await sock.sendMessage(from, { text: '🌌 *DOMAIN LOCKED.* Reach Grade 2 (or own LIMITLESS & SIX-EYES) and forge one with `.domain-n <name>` to use it here.', mentions: [sender] });
            return;
        }
        const cost = 80;
        if (user.stats.CE < cost) {
            await sock.sendMessage(from, { text: `[⚠️ INSUFFICIENT CE: DOMAIN NEEDS ${cost}, YOU HAVE ${user.stats.CE}]`, mentions: [sender] });
            return;
        }
        user.stats.CE -= cost;
        const stats = getCombatStats(user);
        dmg = Math.max(1, Math.floor(stats.attack * 4 + 300));
        techDisplayName = user.domain_unlocked ? (user.domain_name || 'Domain Expansion') : 'Domain Expansion';
        techEffects = ['Sure-hit domain strike'];
        isCrit = true;
        // V2 Domain Mastery
        if (user.domain_mastery) {
            const masteryBonus = Math.min(user.domain_mastery * 0.03, 0.3);
            dmg = Math.floor(dmg * (1 + masteryBonus));
            user.domain_mastery = (user.domain_mastery || 0) + 1;
            user.domain_kills = (user.domain_kills || 0) + 1;
        }
        recordDomainExpansion(user);
        if (enemy.canDomain) {
            const clashWinner = Math.random() < 0.5 ? 'player' : 'enemy';
            if (clashWinner === 'player') {
                combat.enemyDomainBurnout = 2;
                techEffects.push(`⚔️ DOMAIN CLASH! You overpower ${enemy.name}'s domain — it collapses in CE burnout for 2 rounds!`);
            } else {
                combat.playerDomainBurnout = 2;
                techEffects.push(`⚔️ DOMAIN CLASH! ${enemy.name}'s domain overpowers yours — you suffer CE burnout for 2 rounds (attacks only)!`);
            }
        }
    } else if (command === 'attack') {
        const stats = getCombatStats(user);
        dmg = Math.max(1, stats.attack + Math.floor(Math.random() * 12));
        if (Math.random() < (user._combat_crit_chance || 0.05)) { dmg = Math.floor(dmg * 1.5); isCrit = true; }
        if (user.loots?.includes('black_sparks') && Math.random() < 0.09) {
            dmg = Math.floor(dmg * 3);
            combat.enemyStunned = Math.max(combat.enemyStunned || 0, 1);
            techDisplayName = 'BLACK FLASH';
            techEffects = ['⚡ BLACK FLASH! Triple damage + 1-round stun!'];
            isCrit = true;
        }
    } else if (command.startsWith('technique-') || command.startsWith('ut-')) {
        const tnum = command.match(/([1-5])$/);
        let techKey = null, move = null;
        if (tnum && tnum[1] === '5') {
            if (!user.custom_technique) {
                await sock.sendMessage(from, { text: '⚡ No RCT technique forged yet. Unlock one with `.t5r` (requires RCT).', mentions: [sender] });
                return;
            }
            techKey = 'custom_t5r';
            move = user.custom_technique;
            if (args.length > 0) {
                move = { ...move, env: args.join(' ') };
                techEffects = techEffects || [];
                techEffects.push(`🌍 Environment: ${args.join(' ')}`);
            }
        } else if (tnum) {
            techKey = user['technique_' + tnum[1]];
            move = INNATE_TECHNIQUES[user.innate_technique_id]?.moves?.[techKey];
        }
        if (!move) {
            await sock.sendMessage(from, { text: 'Technique not found.', mentions: [sender] });
            return;
        }
         let ceCost = Math.max(20, move.cost || 0);
         if (user._skills?.ce_reduction) ceCost = Math.max(1, Math.floor(ceCost * (1 - user._skills.ce_reduction)));
         const armorCeReduction = getArmorEffect(user, 'ce_reduction') || 0;
         if (armorCeReduction) ceCost = Math.max(1, Math.floor(ceCost * (1 - armorCeReduction)));
           const limitless = user.loots?.includes('limitless_six_eyes') || !!getArmorEffect(user, 'six_eyes_vestments');
        const isHR = !!user.heavenly_restriction;
        if (!limitless && !isHR && user.stats.CE < ceCost) {
            await sock.sendMessage(from, { text: `[⚠️ INSUFFICIENT ENERGY MATRICES: ACTION FORFEITED]\nRequires ${ceCost} CE — you have ${user.stats.CE}.`, mentions: [sender] });
            return;
        }
        if (!limitless && !isHR) user.stats.CE = Math.max(0, user.stats.CE - ceCost);
        else if (limitless) user.stats.CE = user.stats.Max_CE;
        if (techKey === 'super_fast_slash') {
            user._temp_speed_buff = 1.45;
            const heavyMove = INNATE_TECHNIQUES[user.innate_technique_id]?.moves?.heavy_slash;
            if (heavyMove) move = { ...heavyMove, cost: ceCost };
            techDisplayName = 'Super Fast Slash';
            techEffects = ['⚡ Speed increased by 45%! Unleashing Heavy Slash!'];
        } else if (techKey === 'divine_axe_slash') {
            if (user.stats.HP > 10) {
                await sock.sendMessage(from, { text: '⚔️ Divine Axe Slash requires 10 HP or less to unleash!', mentions: [sender] });
                return;
            }
            move = { ...move, damage: 500 };
            techDisplayName = 'Divine Axe Slash';
            techEffects = ['🪓 Divine axe descends — 500 damage!'];
        }
        const techResult = applyTechniqueEffect(move, techKey, user, enemy, combat);
        dmg = techResult.damage;
        techEffects = techResult.narration;
        techDisplayName = move.name || getTechDisplayName(techKey);
        if (Math.random() < (user._combat_crit_chance || 0.05)) { dmg = Math.floor(dmg * 1.5); isCrit = true; }
    } else if (command === 'su') {
        if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); return; }
        const ownedId = (user.ownedSummons && user.ownedSummons.length) ? user.ownedSummons[user.ownedSummons.length - 1] : null;
        const owned = ownedId != null ? SUMMON_SHOP.find(s => s.id === ownedId) : null;
        if (!owned) { await sock.sendMessage(from, { text: '🐾 *NO SUMMON BOUND.* Buy one from .summonshop first.', mentions: [sender] }); return; }
        const atk = summonBattleStats(owned, user.grade, user).atk;
        const hp = atk * 6;
        user.summon = { active: true, name: owned.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: owned.move, effect: owned.effect, pl: owned.pl };
        if (ownedId === 20) {
            user._rika_mode = true;
            user._rika_until = Date.now() + 5 * 60 * 1000;
            user.stats.CE = user.stats.Max_CE;
            dmg = Math.max(1, Math.floor((user.summon.atk || 135000) * 0.4) + 5000);
            techDisplayName = 'Rika: Cursed Energy Beam';
            techEffects = ['💍 Rika manifests — infinite CE for 5 minutes. Beam strike hits for massive damage!'];
        } else {
            dmg = Math.max(1, user.summon.atk + Math.floor(Math.random() * Math.max(1, Math.floor(user.summon.atk * 0.3))));
            techDisplayName = user.summon.move;
            techEffects = [user.summon.effect];
        }
        if (Math.random() < (user._combat_crit_chance || 0.05)) { dmg = Math.floor(dmg * 1.5); isCrit = true; }
        if (Math.random() < 0.08) { isDodge = true; dmg = 0; }
    } else if (command === 'gb') {
        if (!user.loots?.includes('cursed_energy_discharge')) { await sock.sendMessage(from, { text: '⚡ *CURSED ENERGY DISCHARGE REQUIRED.* You need the CURSED ENERGY DISCHARGE loot to use .gb.', mentions: [sender] }); return; }
        const stats = getCombatStats(user);
        dmg = Math.max(1, Math.floor(stats.attack * 2.5) + 300);
        techDisplayName = 'Granité Blast';
        techEffects = ['Ryu-style maximum-output cursed energy beam — tracks, splits into homing vectors, and vaporizes reinforced defenses.'];
        if (Math.random() < (user._combat_crit_chance || 0.05)) { dmg = Math.floor(dmg * 1.8); isCrit = true; }
    } else if (command === 'cm') {
        if (!user.loots?.includes('copy_mimicry')) { await sock.sendMessage(from, { text: '👁️ *COPY (MIMICRY) REQUIRED.* You need the COPY loot to use .cm.', mentions: [sender] }); return; }
        if (!user._copied_techniques || !user._copied_techniques.length) { await sock.sendMessage(from, { text: '📋 No techniques copied yet. Defeat enemies to copy their innate techniques (up to 3).', mentions: [sender] }); return; }
        const idx = parseInt(args[0]) || 1;
        const copied = user._copied_techniques[Math.max(0, Math.min(idx - 1, user._copied_techniques.length - 1))];
        if (!copied) { await sock.sendMessage(from, { text: '📋 Invalid copy slot.', mentions: [sender] }); return; }
        const fakeEnemy = { name: enemy.name, grade: enemy.grade, stats: enemy.stats, skills: enemy.skills || {} };
        const res = applyTechniqueEffect(copied, copied._key || 'copied', user, fakeEnemy, combat);
        dmg = res.damage;
        techDisplayName = `COPY: ${copied.name || 'Mimicked Technique'}`;
        techEffects = [`Yuta/Rika replicate ${copied.name || 'a copied technique'} with maximum refinement.`];
        if (Math.random() < 0.15) { dmg = Math.floor(dmg * 1.3); isCrit = true; }
    } else if (command === 'bw') {
        if (!user.loots?.includes('boogie_woogie')) { await sock.sendMessage(from, { text: '👏 *BOOGIE WOOOGIE REQUIRED.* You need the BOOGIE WOOOGIE loot to use .bw.', mentions: [sender] }); return; }
        dmg = Math.max(1, Math.floor((enemy.stats?.atk || 10) * 0.8));
        techDisplayName = 'Boogie Woogie';
        techEffects = ['Todo claps — coordinates swap! The enemy is hit by their own attack for ~80% of their ATK.'];
        if (Math.random() < 0.2) { dmg = Math.floor(dmg * 1.5); isCrit = true; }
    } else if (command === 'csm') {
        if (!user.loots?.includes('cursed_spirit_manipulation')) { await sock.sendMessage(from, { text: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.* You need the CURSED SPIRIT MANIPULATION loot to use .csm.', mentions: [sender] }); return; }
        const army = user._cursed_army || [];
        if (!army.length) { await sock.sendMessage(from, { text: '🌀 No curses absorbed yet. Defeat cursed spirits to absorb them into your army.', mentions: [sender] }); return; }
        if (args[0] && args[0].toLowerCase() === 'list') {
            let msg = `🌀 *CURSED ARMY: ${army.length} absorbed*\n───\n`;
            army.forEach((c, i) => { msg += `${i + 1}. *${c.name}* (Grade ${c.grade})\n`; });
            msg += `\nUse *.csm${Math.min(army.length, 9)}* to unleash a specific curse.`;
            await sock.sendMessage(from, { text: msg, mentions: [sender] });
            return;
        }
        const csmMatch = command.match(/^csm(\d+)$/);
        if (csmMatch) {
            const idx = parseInt(csmMatch[1]) - 1;
            if (idx < 0 || idx >= army.length) { await sock.sendMessage(from, { text: `🌀 Invalid slot. Use .csm list to see your ${army.length} absorbed curse(s).`, mentions: [sender] }); return; }
            const curse = army[idx];
            dmg = Math.max(1, Math.floor(120 + (enemy.grade === 0 ? 300 : enemy.grade === 1 ? 200 : 100)));
            techDisplayName = `Maximum: ${curse.name}`;
            techEffects = [`🌀 Released ${curse.name} (Grade ${curse.grade}) — compressed spirit strike!`];
            user._cursed_army.splice(idx, 1);
            if (Math.random() < 0.25) { dmg = Math.floor(dmg * 1.4); isCrit = true; }
            return;
        }
        dmg = Math.max(1, Math.floor(army.length * 120) + 500);
        techDisplayName = 'Maximum: Uzumaki';
        techEffects = [`Condensed laser spiral from ${army.length} absorbed curse spirits — massive pierce damage.`];
        user._cursed_army = [];
        if (Math.random() < 0.25) { dmg = Math.floor(dmg * 1.4); isCrit = true; }
    } else if (command === 'csm-r') {
        if (!user.loots?.includes('cursed_spirit_manipulation')) { await sock.sendMessage(from, { text: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.* You need the CURSED SPIRIT MANIPULATION loot to use .csm-r.', mentions: [sender] }); return; }
        const army = user._cursed_army || [];
        if (!army.length) { await sock.sendMessage(from, { text: '🌀 No curses absorbed yet. Defeat cursed spirits to absorb them into your army.', mentions: [sender] }); return; }
        combat._cursed_army = [...army];
        user._cursed_army = [];
        dmg = 0;
        techDisplayName = 'Maximum: Release';
        techEffects = [`Released ${army.length} absorbed curse spirits to defend you!`];
    } else if (command === 'it') {
        if (!user.loots?.includes('idle_transfiguration')) { await sock.sendMessage(from, { text: '👁️ *IDLE TRANSFIGURATION REQUIRED.* You need the IDLE TRANSFIGURATION loot to use .it.', mentions: [sender] }); return; }
        if (enemy.loots?.includes('black_sparks')) {
            dmg = 0;
            techDisplayName = 'Idle Transfiguration (blocked)';
            techEffects = ['🛡️ BLACK SPARKS shields the target — Idle Transfiguration has no effect!'];
            isDodge = true;
        } else {
            dmg = 1800;
            techDisplayName = 'Idle Transfiguration: Soul Shaping';
            techEffects = ['Mahito reshapes the target\'s soul — 1800 damage, bypassing all armor/stats!'];
            isCrit = true;
        }
    } else if (command === 'jd') {
        if (!user.loots?.includes('courtroom_domain')) { await sock.sendMessage(from, { text: '⚖️ *COURTROOM DOMAIN REQUIRED.* You need the COURTRDOM DOMAIN EXPANSION loot to use .jd.', mentions: [sender] }); return; }
        dmg = 0; isDodge = true;
        techDisplayName = 'Courtroom Domain: Deadly Sentencing';
        const isCurse = enemy.grade === 0 || enemy.name?.toLowerCase().includes('curse');
        combat._enemy_original_skills = { ...enemy.skills };
        combat._enemy_original_technique = enemy.technique;
        enemy.skills = {};
        enemy.technique = null;
        combat._judgeman_rounds = 3;
        combat._judgeman_weak = true;
        if (isCurse) {
            enemy.stats.HP = 0;
            techEffects = ['⚖️ Judgeman: GUILTY! The curse is sentenced to death — Executioner\'s Sword strikes true!'];
        } else {
            techEffects = ['⚖️ Judgeman: INNOCENT! The defendant is spared. Their techniques are sealed and attacks weakened for 3 rounds.'];
        }
    } else if (command === 'jd1') {
        if (!user.loots?.includes('courtroom_domain')) { await sock.sendMessage(from, { text: '⚖️ *COURTROOM DOMAIN REQUIRED.* You need the COURTRDOM DOMAIN EXPANSION loot.', mentions: [sender] }); return; }
        if (!user._judgeman_executioner_ready) { await sock.sendMessage(from, { text: '⚖️ Executioner\'s Sword is not ready. Use `.jd` on a cursed spirit first to sentence them.', mentions: [sender] }); return; }
        user._judgeman_executioner_ready = false;
        dmg = 5000;
        techDisplayName = 'Executioner\'s Sword';
        techEffects = ['⚖️ The Executioner\'s Sword descends — 5000 damage!'];
        if (Math.random() < 0.25) { dmg = Math.floor(dmg * 2); isCrit = true; }
    } else if (command === 'su') {
        if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); return; }
        const ownedId = (user.ownedSummons && user.ownedSummons.length) ? user.ownedSummons[user.ownedSummons.length - 1] : null;
        const owned = ownedId != null ? SUMMON_SHOP.find(s => s.id === ownedId) : null;
        if (!owned) { await sock.sendMessage(from, { text: '🐾 *NO SUMMON BOUND.* Buy one from .summonshop first.', mentions: [sender] }); return; }
        const atk = summonBattleStats(owned, user.grade, user).atk;
        const hp = atk * 6;
        user.summon = { active: true, name: owned.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: owned.move, effect: owned.effect, pl: owned.pl };
        if (ownedId === 20) {
            user._rika_mode = true;
            user._rika_until = Date.now() + 5 * 60 * 1000;
            user.stats.CE = user.stats.Max_CE;
            dmg = Math.max(1, Math.floor((user.summon.atk || 135000) * 0.4) + 5000);
            techDisplayName = 'Rika: Cursed Energy Beam';
            techEffects = ['💍 Rika manifests — infinite CE for 5 minutes. Beam strike hits for massive damage!'];
        } else {
            dmg = Math.max(1, user.summon.atk + Math.floor(Math.random() * Math.max(1, Math.floor(user.summon.atk * 0.3))));
            techDisplayName = user.summon.move;
            techEffects = [user.summon.effect];
        }
        if (Math.random() < (user._combat_crit_chance || 0.05)) { dmg = Math.floor(dmg * 1.5); isCrit = true; }
        if (Math.random() < 0.08) { isDodge = true; dmg = 0; }
    } else {
        return;
    }

    dmg = Math.floor(dmg * playerDmgMult);
    
    // Distance check for Dark Continent combat
    if (combat.darkRegion && dmg > 0) {
        const dist = combat.distance || 5;
        const isMelee = command === 'attack' || command === 'wa' || techKey?.includes('slash') || techKey?.includes('strike') || techKey?.includes('punch');
        const isRanged = techKey?.includes('beam') || techKey?.includes('blast') || techKey?.includes('projectile') || techKey?.includes('laser') || techKey?.includes('arrow');
        
        if (isMelee && dist > 3) {
            dmg = 0;
            techEffects = techEffects || [];
            techEffects.push(`💨 Too far! Melee range is 1-3m. Distance: ${dist}m`);
        } else if (isRanged && dist < 10) {
            dmg = Math.floor(dmg * 0.3);
            techEffects = techEffects || [];
            techEffects.push(`⚠️ Too close! Ranged attacks need 10m+ clearance. Self-damage risk! Distance: ${dist}m`);
        }
    }
    
    // Ecological Chaos modifiers
    if (combat.darkRegion && combat.ecologicalEvent && dmg > 0) {
        const event = combat.ecologicalEvent;
        if (event.effect === 'gravity' && command === 'attack') {
            dmg = 0;
            techEffects = techEffects || [];
            techEffects.push(`🌌 GRAVITY INVERSION! Melee attacks fail!`);
        }
        if (event.effect === 'resonance') {
            dmg = Math.floor(dmg * (event.damageMult || 1.25));
            techEffects = techEffects || [];
            techEffects.push(`🔊 RESONANCE: Damage amplified!`);
        }
    }
    
    // Status Effect Interlocking
    if (combat.darkRegion && dmg > 0) {
        const skillName = (move?.name || '').toLowerCase();
        const enemyWet = combat.enemyStatus?.find(s => s.type === 'WET');
        if (enemyWet && (skillName.includes('lightning') || skillName.includes('chidori') || skillName.includes('electric'))) {
            dmg = Math.floor(dmg * 2.5);
            techEffects = techEffects || [];
            techEffects.push(`⚡ CONDUCTIVE LOOP: 2.5x damage!`);
        }
        const enemyBleed = combat.enemyStatus?.find(s => s.type === 'BLEED');
        if (enemyBleed && skillName.includes('poison')) {
            techEffects = techEffects || [];
            techEffects.push(`☠️ BLOOD-ROT CATALYST: Poison enters wounds!`);
        }
    }
    
    if (dmg > 0) enemy.stats.HP -= dmg;

    // Released curses (CSM) also auto-attack the enemy each turn
    if (combat._cursed_army && combat._cursed_army.length > 0) {
        const curseArmyDmg = Math.max(1, Math.floor(combat._cursed_army.length * 80));
        enemy.stats.HP -= curseArmyDmg;
        techEffects.push(`🌀 ${combat._cursed_army.length} released curses strike for ${curseArmyDmg} damage!`);
    }

    // Apply WET status for water/ice skills (conductive loop setup)
    if (combat.darkRegion && dmg > 0) {
        const skillName = (move?.name || '').toLowerCase();
        if (skillName.includes('water') || skillName.includes('ice') || skillName.includes('ice-make')) {
            applyEnemyStatus(combat, { type: 'WET', name: 'Drenched', turns: 3 });
            techEffects = techEffects || [];
            techEffects.push(`💧 Enemy soaked! Lightning attacks will deal 2.5x damage!`);
        }
    }

    // Blood-Rot Catalyst: poison ticks twice as fast on bleeding enemies
    if (combat.darkRegion && combat.enemyStatus?.find(s => s.type === 'BLEED')) {
        const enemyDot = combat.enemyStatus.find(s => s.type === 'BLEED');
        if (enemyDot && enemyDot.dot) {
            const extraDot = Math.max(1, Math.floor(enemy.stats.Max_HP * enemyDot.dot));
            enemy.stats.HP = Math.max(0, enemy.stats.HP - extraDot);
            techEffects = techEffects || [];
            techEffects.push(`☠️ BLOOD-ROT: Poison enters wounds! Extra ${extraDot} damage!`);
        }
    }

    if (enemy.stats.HP <= 0) {
         recordCurseDefeat(user, enemy);
         endCombatKeys(combat);
         const xpBoost = getArmorEffect(user, 'xp_boost') || 0;
         user.xp += Math.floor(4000 * (1 + xpBoost));
         user.wallet += 5000;
        user.skill_points = (user.skill_points || 0) + 1;
        user.corruption = Math.max(0, (user.corruption || 0) - 5);
        if (combat.villageId) {
            const v = db.villages[combat.villageId];
            if (v) {
                v.mission = null;
                v.rebellion = false;
                v.liberated = (v.liberated || 0) + 1;
                const missionClass = combat.missionClass || 'C';
                const missionRewards = {
                    'SSS': { gold: 200_000_000_000, xp: 500_000 },
                    'SS': { gold: 200_000_000, xp: 100_000 },
                    'S': { gold: 6_000_000, xp: 60_000 },
                    'A': { gold: 500_000, xp: 20_000 },
                    'B': { gold: 200_000, xp: 10_000 },
                    'C': { gold: 80_000, xp: 5_000 },
                    'D': { gold: 30_000, xp: 2_000 },
                    'E': { gold: 10_000, xp: 1_000 }
                };
                const rewards = missionRewards[missionClass] || missionRewards['C'];
                user.wallet = (user.wallet || 0) + rewards.gold;
                user.xp += rewards.xp;
            }
        }
        checkLevelUp(user);
        updateDarkRegionLogbook(combat, user, 'victory');
        saveDb();
        if (!db._firstBloodWinner && db._bootTime && user.registered && (Date.now() - db._bootTime < 10 * 60 * 1000)) {
            db._firstBloodWinner = sender;
            const granted = grantLoot(user, 'courtroom_domain', true);
            if (granted) {
                saveDb();
                await sock.sendMessage(from, { text: `🏆 *FIRST BLOOD!*\nYou were the first registered user to defeat a curse within the first 10 minutes!\nYou received *${granted.name}*!`, mentions: [sender] });
            }
        }
        const reward = `🛡️ You completed the villager's request and drove the clan enforcers out! The village is grateful.\n🎁 +${fmtNum(combat.missionRewardXp || 4000)} XP, +${fmtNum(combat.missionRewardGold || 5000)} K-Coins, Corruption -5.`;
        await sock.sendMessage(from, { text: reward, mentions: [sender] });
        return;
    }

    const phase = runEnemyPhase(combat, user);
    let extraComboDmg = 0;
    if ((enemy.comboChance || 0) > Math.random() && user.stats.HP > 0) {
        extraComboDmg = Math.max(1, Math.floor(enemy.atk * (0.6 + Math.random() * 0.5)));
        if (combat.guarding) { user.stats.HP -= Math.floor(extraComboDmg * 0.4); }
        else { user.stats.HP -= extraComboDmg; }
        combat.guarding = false;
    }
    if (user.stats.HP <= 0) {
        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
        updateDarkRegionLogbook(combat, user, 'defeat');
        user.corruption = Math.min(100, (user.corruption || 0) + 8);
        saveDb();
        await sock.sendMessage(from, { text: `💀 The enemy overpowers you.\nCorruption +8.\n${r}`, mentions: [sender] });
        return;
    }

                combat.round++;
                if (getArmorEffect(user, 'dharma_armor')) {
                    user._dharma_stacks = (user._dharma_stacks || 0) + 1;
                }
                combat.counter_state = false;
    combat.enemyIntent = pickEnemyMove();
    saveDb();
    const domainLine = phase.domain ? `🌌 ${enemy.name} EXPANDED ITS DOMAIN — *${phase.domainName}*! Sure-hit for *${phase.eDamage}* damage!` : null;
    const hitLine = phase.eDamage > 0 ? `👹 ${enemy.name} struck for *${phase.eDamage}* damage${phase.guarded ? ' (guarded −60%)' : ''}` : `💨 ${heroName} weathered the assault unharmed`;
    const comboLine = extraComboDmg > 0 ? `💥 COMBO! ${enemy.name} follows up for *${extraComboDmg}* additional damage!` : null;
    const caption = [
        `📜 *MISSION — BATTLE*`,
        `${heroName} ${techDisplayName ? `unleashed *${techDisplayName}*` : 'attacked'}${isCrit ? ' (CRITICAL!)' : ''}`,
        dmg > 0 ? `💥 Dealt *${dmg}* damage to ${enemy.name}` : `💨 ...but ${enemy.name} slipped away — no damage!`,
        techEffects.length ? `✨ Effect: ${techEffects.join(', ')}` : null,
        domainLine,
        hitLine,
        comboLine,
        `❤️ ${heroName}: ${Math.max(0, user.stats.HP)}/${user.stats.Max_HP} HP | ⚡ ${ceFor(user)} CE`,
        `👾 ${enemy.name}: ${Math.max(0, enemy.stats.HP)}/${enemy.stats.Max_HP} HP`,
        `👁️ Enemy intent: ${enemyIntentHint(combat.enemyIntent)}`,
        `*Actions:* .attack | .technique-1..4 | .guard | .flee`
    ].filter(Boolean).join('\n');
    await sock.sendMessage(from, { text: caption, mentions: [sender] });
}

async function tickWorldLife(sock) {
    if (!sock) return;
    try {
        ensureWorld();
        for (const [id, v] of Object.entries(db.villages)) {
            v.population = Math.max(50, (v.population || 1000) + Math.floor(Math.random() * 60));
            if (!v.clan && Math.random() < 0.08) {
                const cn = pick(EVIL_CLAN_NAMES);
                v.clan = cn;
                v.coloniserClanName = cn;
                v.rebellion = true;
            }
            if (v.clan) {
                const killed = Math.floor(Math.random() * 40);
                v.population = Math.max(50, v.population - killed);
                v.wealth = (v.wealth || 0) + killed * 50;
            }
            if (!v.mission && Math.random() < 0.25) {
                const cn = v.clan || v.coloniserClanName || pick(EVIL_CLAN_NAMES);
                const missionClasses = [
                    { class: 'SSS', minLevel: 150, danger: 5, rewardGold: 500_000, rewardXp: 500_000, enemyGrade: 0, enemyMult: 4.0 },
                    { class: 'SS', minLevel: 70, danger: 4, rewardGold: 500_000, rewardXp: 100_000, enemyGrade: 1, enemyMult: 2.5 },
                    { class: 'S', minLevel: 30, danger: 3, rewardGold: 500_000, rewardXp: 60_000, enemyGrade: 2, enemyMult: 1.8 },
                    { class: 'A', minLevel: 10, danger: 2, rewardGold: 500_000, rewardXp: 20_000, enemyGrade: 3, enemyMult: 1.2 },
                    { class: 'B', minLevel: 1, danger: 2, rewardGold: 500_000, rewardXp: 10_000, enemyGrade: 3, enemyMult: 1.0 },
                    { class: 'C', minLevel: 1, danger: 1, rewardGold: 500_000, rewardXp: 5_000, enemyGrade: 4, enemyMult: 0.8 },
                    { class: 'D', minLevel: 1, danger: 1, rewardGold: 500_000, rewardXp: 2_000, enemyGrade: 4, enemyMult: 0.6 },
                    { class: 'E', minLevel: 1, danger: 0, rewardGold: 500_000, rewardXp: 1_000, enemyGrade: 4, enemyMult: 0.4 }
                ];
    const weights = [5, 5, 10, 20, 30, 20, 5, 5];
                const missionClass = pickWeighted(missionClasses, weights);
                v.mission = {
                    title: pick(['Drive out the traffickers','Rescue the taken villagers','Slay the clan enforcer','Break the clan\'s grip','Protect the caravan']),
                    clan: cn,
                    class: missionClass.class,
                    danger: missionClass.danger,
                    reward: missionClass.rewardGold,
                    rewardXp: missionClass.rewardXp,
                    enemyGrade: missionClass.enemyGrade,
                    enemyMult: missionClass.enemyMult,
                    desc: `Clan "${cn}" terrorizes ${v.name}. Villagers beg for a sorcerer to intervene. ${missionClass.class}-class threat detected.`
                };
            }
        }

        if (db.darkContinent?.pandoraBox?.kingsUnleashed && Math.random() < 0.3) {
            const villages = Object.values(db.villages || {});
            if (villages.length > 0) {
                const target = pick(villages);
                const killed = Math.floor(Math.random() * 500) + 50;
                target.population = Math.max(0, (target.population || 1000) - killed);
                target.wealth = Math.max(0, (target.wealth || 100000) - killed * 100);
                if (target.population === 0) {
                    target.colonisedBy = null;
                    target.coloniserClanName = null;
                    target.tax = 0;
                    target.rebellion = false;
                    target.mission = null;
                }
                try {
                    broadcastAllGroups(sock, `👑 *PANDORA'S KINGS RAMPAGE!*\nThe Kings of Pandora have attacked *${target.name}*!\n${killed} villagers killed. The village is in ruins.`);
                } catch {}
            }
        }

        // Dark Continent sanity drain over time
        if (db.darkContinent?.regions) {
            for (const user of Object.values(db.users)) {
                if (!user.registered || !user.player_id) continue;
                const region = Object.values(db.darkContinent.regions).find(r => r.exploredBy?.includes(user.player_id));
                if (!region) continue;
                
                // Sanity drain for being in Dark Continent
                const sanityDrain = region.danger * 2;
                user.sanity = Math.max(0, (user.sanity || 100) - sanityDrain);
                
                // Environmental effects
                if (region.environmental) {
                    const env = region.environmental;
                    if (env.effect === 'decay') {
                        const hpDrain = Math.max(1, Math.floor(user.stats.Max_HP * (env.hpDrain || 0.03)));
                        const ceDrain = Math.max(1, Math.floor(user.stats.Max_CE * (env.ceDrain || 0.03)));
                        user.stats.HP = Math.max(1, user.stats.HP - hpDrain);
                        user.stats.CE = Math.max(0, user.stats.CE - ceDrain);
                    } else if (env.effect === 'sanity_drain') {
                        user.sanity = Math.max(0, user.sanity - (env.sanityDrain || 5));
                    }
                }
                
                // Despair state at 0% sanity
                if (user.sanity <= 0 && !user.active_status_effects?.find(s => s.name === 'PANIC')) {
                    user.active_status_effects = user.active_status_effects || [];
                    user.active_status_effects.push({ name: 'PANIC', turns: 999, evasion: 0, damageTakenMult: 1.5 });
                }
            }
        }

        // Region rotation check (every 24 hours)
        rotateRegions();

        if (db.cullingGame?.active) {
            tickCullingGame(sock).catch(() => {});
            startAIRuleGenerator(sock);
        }
        saveDb();
    } catch (e) { logger.error({ err: e }, '[WORLD]'); }
}

// ── Unique loot system ──
// Each loot is one-of-a-kind on the whole bot (only BLACK SPARKS can be owned by many).
// When a curse is defeated there is a 30% chance to drop a loot; LIMITLESS & SIX-EYES is
// gated to a 2% overall chance. A loot claimed from a curse leaves the pool; a loot given
// by a mod via .give-loot does NOT leave the pool.
const LOOTS = {
    midas_touch:        { id: 'midas_touch',        name: 'MIDAS TOUCH',        unique: true,  desc: 'Greatly increases Max HP but massively drains speed (you become slow).' },
    limitless_six_eyes: { id: 'limitless_six_eyes', name: 'LIMITLESS & SIX-EYES', unique: true, dropChance: 0.02, desc: 'Unlimited cursed energy, +50x attack, and the Domain Expansion: Infinite Void.' },
    black_sparks:       { id: 'black_sparks',       name: 'BLACK SPARKS',       unique: false, dropChance: 0.04, desc: 'Immune to Idle Transfiguration. Every .attack has a 9% chance to trigger a Black Flash — triple damage + 1-round stun.' },
    jackpot:            { id: 'jackpot',            name: 'JACKPOT',            unique: true,  desc: 'Use .jk for 6 minutes of infinite HP and CE. Permanently unlocks Reverse Cursed Technique (RCT).' },
    honoured_one:       { id: 'honoured_one',       name: 'HONOURED ONE',       unique: true,  desc: 'Use .taunt to scare off weaker enemies or show your overwhelming aura.' },
    king_of_curses:     { id: 'king_of_curses',     name: 'KING OF CURSES',     unique: true,  desc: 'At Special Grade, your power rivals Sukuna himself.' },
    daddyraga:          { id: 'daddyraga',          name: 'DADDYRAGA',          unique: true,  desc: 'Adapts to any attack used on you more than once; only a one-shot can fell you.' },
    sovereigns_core:     { id: 'sovereigns_core',     name: "SOVEREIGN'S CORE",    unique: true,  dropChance: 0.03, desc: 'Dual-Heart Curse Mutation: house two Innate Techniques at once. +35% Cursed Energy output, -20% Max HP.' },
    projection_sorcery:  { id: 'projection_sorcery',  name: 'PROJECTION SORCERY',   unique: true,  dropChance: 0.03, desc: 'Zenin 24-FPS movement: +60% SPEED but -55% STRENGTH (attack).' },
    blood_manipulation:  { id: 'blood_manipulation',  name: 'BLOOD MANIPULATION',  unique: true,  dropChance: 0.03, desc: 'Kamo bio-tactical control: boosts physical stats. Use .bu in combat for a piercing blood beam.' },
    comedian:            { id: 'comedian',            name: 'COMEDIAN',            unique: true,  dropChance: 0.008, desc: 'Any funny thought becomes absolute reality. Use .co: attacks on you fail, but 30s burnout (only .attack usable).' },
    entropys_loom:       { id: 'entropys_loom',       name: "ENTROPY'S LOOM",     unique: true,  dropChance: 0.03, desc: 'Probability manipulation. Use .vow in combat: sacrifice healing 3 turns to nullify enemy healing/defense.' },
    cursed_energy_discharge: { id: 'cursed_energy_discharge', name: 'CURSED ENERGY DISCHARGE', unique: true, dropChance: 0.03, desc: 'Ryu-style maximum raw CE output. Base attacks always strike at full explosive capacity. Ultimate: .gb Granité Blast — tracking homing beam that vaporizes defenses.' },
    copy_mimicry:        { id: 'copy_mimicry',        name: 'COPY (MIMICRY)',     unique: true,  dropChance: 0.02, desc: 'Yuta/Rika consume a target DNA signature to copy up to 3 innate techniques. Copied techniques are only usable during Rika 5-minute full-manifestation phase. Use .cm in combat.' },
    boogie_woogie:       { id: 'boogie_woogie',       name: 'BOOGIE WOOOGIE',     unique: true,  dropChance: 0.03, desc: 'Todo-style coordinate swap. Clap to swap yourself with enemy — enemy gets hit by their own attack. Use .bw in combat.' },
    cursed_spirit_manipulation: { id: 'cursed_spirit_manipulation', name: 'CURSED SPIRIT MANIPULATION', unique: true, dropChance: 0.03, desc: 'Absorb lower-grade curse spirits into a private army. Ultimate: .csm Maximum: Uzumaki — compressed laser spiral that deals pierce damage and extracts Special Grade innate techniques.' },
    idle_transfiguration: { id: 'idle_transfiguration', name: 'IDLE TRANSFIGURATION', unique: true, dropChance: 0.02, desc: "Mahito's soul-shaping. 13% chance on hit to oneshot by reshaping the target's soul, bypassing all armor/stats. Use .it in combat." },
    courtroom_domain:    { id: 'courtroom_domain',    name: 'COURTROOM DOMAIN EXPANSION', unique: true, dropChance: 0.015, desc: "Higuruma's Judgeman courtroom barrier. Use .jd in combat. Guilty (3-turn technique lock) or Death Penalty (Executioner's Sword instakill). VS cursed spirits: drains all their CE into you." },
};
const QUIRKS = {
    kinetic_impact:     { id: 'kinetic_impact',     name: 'KINETIC IMPACT',     damage: 150, effect: 'armor_break', desc: 'Accumulates kinetic force and unleashes a high-impact melee strike that shatters armor defenses.' },
    volcanic_veins:     { id: 'volcanic_veins',     name: 'VOLCANIC VEINS',     damage: 200, effect: 'burn',        dot: 30, turns: 3, desc: 'Converts sweat to magma. Launches long-range linear blasts that melt cover and inflict continuous burn ticks over 3 turns.' },
    overclock:          { id: 'overclock',          name: 'OVERCLOCK',          damage: 120, effect: 'multi_hit',   hits: 3,     desc: 'Accelerates nervous system for rapid multi-hit physical attacks. Deals rapid strikes but drains stamina quickly.' },
    shatterpoint:       { id: 'shatterpoint',       name: 'SHATTERPOINT',       damage: 180, effect: 'crit_guaranteed', desc: 'Sees structural weak spots. Attacks hit exact coordinates for guaranteed critical damage, bypassing base defense.' },
    aero_vortex:        { id: 'aero_vortex',        name: 'AERO-VORTEX',        damage: 120, effect: 'pull_stun',   stun: 1,     desc: 'Controls air currents to generate crushing vacuum spheres. Pulls enemies into a single point and interrupts their active states.' },
    ironclad_density:   { id: 'ironclad_density',   name: 'IRONCLAD DENSITY',   damage: 80,  effect: 'defend',                  desc: 'Hardens cellular structure to match reinforced steel. Cuts incoming damage and turns tackles into high-weight blunt strikes.' },
    decay_vector:       { id: 'decay_vector',       name: 'DECAY VECTOR',       damage: 60,  effect: 'dot_scaling', dot: 20, turns: 5, desc: 'Spreads rotting disintegration. Low initial damage but scales up exponentially every turn the target fails to clear it.' },
    photon_beam:        { id: 'photon_beam',        name: 'PHOTON BEAM',        damage: 170, effect: 'pierce',                  desc: 'Condenses solar energy into precise laser beams. Pierces through straight lines, hitting all targets lined up back-to-back.' },
    soundwave_pulse:    { id: 'soundwave_pulse',    name: 'SOUNDWAVE PULSE',    damage: 110, effect: 'stun',        stun: 1,     desc: 'Releases high-frequency directional sound waves. Breaks target stance coordination and applies a mandatory stun check.' },
    rebound_barrier:    { id: 'rebound_barrier',    name: 'REBOUND BARRIER',    damage: 90,  effect: 'reflect_setup',           desc: 'Creates a translucent jelly-like shield. Absorbs incoming projectiles and redirects damage back along its original trajectory.' },
};
const UNIQUE_LOOT_IDS = Object.values(LOOTS).filter(l => l.unique).map(l => l.id);

function pickRandomQuirks(count) {
    const allQuirks = Object.keys(QUIRKS);
    const shuffled = allQuirks.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, allQuirks.length)).map(id => QUIRKS[id]);
}
function resolveQuirkByName(q) {
    if (!q) return null;
    const s = String(q).toLowerCase().trim();
    for (const quirk of Object.values(QUIRKS)) {
        if (quirk.id === s || quirk.name.toLowerCase() === s) return quirk;
    }
    for (const quirk of Object.values(QUIRKS)) {
        if (quirk.name.toLowerCase().includes(s) || s.includes(quirk.name.toLowerCase())) return quirk;
    }
    return null;
}

function initLootPool() {
    if (!db.lootPool) db.lootPool = {};
    for (const id of UNIQUE_LOOT_IDS) if (db.lootPool[id] === undefined) db.lootPool[id] = true;
}
function availableLootIds() {
    initLootPool();
    return UNIQUE_LOOT_IDS.filter(id => db.lootPool[id]);
}
// Grant a loot to a user. consume=true removes a unique loot from the global pool
// (curse drops); consume=false keeps it in the pool (mod-given copies).
const _lootLocks = new Set();
function grantLoot(user, id, consume = true) {
    if (!LOOTS[id]) return null;
    if (user.heavenly_restriction) return null;
    user.loots = user.loots || [];
    // Loot is PERMANENT once obtained. Ignore any further attempts to grant/swap.
    if (user.loots.length > 0) return null;
    // Simple per-user lock to prevent race conditions in concurrent async handlers
    const lockKey = user.player_id || user.name;
    if (_lootLocks.has(lockKey)) return null;
    _lootLocks.add(lockKey);
    try {
        user.loots.push(id);
        applyLootEffects(user);
        if (consume && LOOTS[id].unique) db.lootPool[id] = false;
        return LOOTS[id];
    } finally {
        _lootLocks.delete(lockKey);
    }
}
// Undo the persistent stat changes granted by the loots currently in user.loots.
function revertLootEffects(user) {
    user.loots = user.loots || [];
    if (user.loots.includes('limitless_six_eyes')) {
        const baseCE = 100 + (user.level - 1) * 5;
        user.stats.Max_CE = baseCE;
        user.stats.CE = Math.min(user.stats.CE || 0, baseCE);
    }
    if (user.loots.includes('midas_touch')) {
        user.stats.Max_HP = Math.max(1, (user.stats.Max_HP || 120) - 300);
        user.stats.HP = Math.min(user.stats.HP || 0, user.stats.Max_HP);
        user._midasApplied = false;
    }
    if (user.loots.includes('sovereigns_core') && user._sovereignApplied) {
        const newMax = Math.floor((user.stats.Max_HP || 120) / 0.8);
        user.stats.HP = Math.floor((user.stats.HP || newMax) / 0.8);
        user.stats.Max_HP = newMax;
        user._sovereignApplied = false;
    }
}
function resolveLootByName(q) {
    if (!q) return null;
    const s = String(q).toLowerCase().trim();
    for (const l of Object.values(LOOTS)) {
        if (l.id === s || l.name.toLowerCase() === s) return l;
    }
    // loose substring match (e.g. "six eyes", "midas")
    for (const l of Object.values(LOOTS)) {
        if (l.name.toLowerCase().includes(s) || s.includes(l.name.toLowerCase())) return l;
    }
    return null;
}
// Apply persistent stat changes from owned loots.
function applyLootEffects(user) {
    user.loots = user.loots || [];
    if (user.loots.includes('limitless_six_eyes')) {
        user.stats.Max_CE = Infinity;
        user.stats.CE = Infinity;
        user.innate_technique_id = 'Limitless';
        user.technique_1 = 'blue';
        user.technique_2 = 'red';
        user.technique_3 = 'purple';
        user.technique_4 = user.technique_4 || null;
        user.skills = INNATE_TECHNIQUES['Limitless']?.moves || user.skills;
    }
    if (user.loots.includes('midas_touch')) {
        // +300 Max HP (applied once-style bump tracked so it isn't stacked repeatedly)
        if (!user._midasApplied) {
            user.stats.Max_HP = (user.stats.Max_HP || 120) + 300;
            user.stats.HP = user.stats.Max_HP;
            user._midasApplied = true;
        }
    }
    if (user.loots.includes('sovereigns_core')) {
        // Dual-Heart Curse Mutation: -20% Max HP pool (applied once, tracked for clean revert).
        if (!user._sovereignApplied) {
            const newMax = Math.max(1, Math.floor((user.stats.Max_HP || 120) * 0.8));
            user.stats.HP = Math.max(1, Math.floor((user.stats.HP || newMax) * 0.8));
            user.stats.Max_HP = newMax;
            user._sovereignApplied = true;
        }
    }
}
function hasLoot(user, id) { return !!(user.loots && user.loots.includes(id)); }

// Weighted unique-loot pick honouring each loot's dropChance (rarer loots drop less often).
function pickWeightedLoot(ids) {
    const weights = ids.map(id => Math.max(0.0001, LOOTS[id]?.dropChance ?? 0.03));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < ids.length; i++) { r -= weights[i]; if (r <= 0) return ids[i]; }
    return ids[ids.length - 1];
}

// ── JJK-faithful power model ──
// Grade is the DOMINANT power axis (a Special Grade is in a different league than a
// Grade 4). Level is a smooth within-grade progression that ramps a sorcerer from the
// floor of their grade toward the floor of the next grade. Each grade step is ~2.3x,
// mirroring the dramatic jumps in Jujutsu Kaisen. Power is fully bounded: beyond
// Special Grade the curve flattens so endless grinding can't break balance.
const MAX_LEVEL = 1000;
 const GRADE_BANDS = {
     4: { start: 1,   end: 9 },     // Grade 4:  lvl 1-9
     3: { start: 10,  end: 29 },    // Grade 3:  lvl 10-29
     2: { start: 30,  end: 69 },    // Grade 2:  lvl 30-69
     1: { start: 70,  end: 699 },   // Grade 1:  lvl 70-699
     0: { start: 700, end: null }   // Special:  lvl 700+
 };
const POWER_TIER = {
    4: { atk: 16,  def: 11,  spd: 14 },
    3: { atk: 38,  def: 26,  spd: 32 },
    2: { atk: 88,  def: 58,  spd: 72 },
    1: { atk: 200, def: 130, spd: 160 },
    0: { atk: 460, def: 300, spd: 360 }
};

const MAX_ATTACK = 50000;
const MAX_DEFENSE = 30000;
const MAX_SPEED = 20000;

function calcPower(user) {
    const trained = user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 };
    let atk = POWER_TIER[4].atk + trained.attack + (user._bonus_attack || 0);
    let def = POWER_TIER[4].def + trained.defense + (user._bonus_defense || 0);
    let spd = POWER_TIER[4].spd + (trained.speed || 0);
    if (user._temp_speed_buff) spd = Math.round(spd * user._temp_speed_buff);
    const perks = getTitlePerks(user.title);
    if (perks.bonus_attack) atk += perks.bonus_attack;
    if (perks.bonus_defense) def += perks.bonus_defense;
    if (perks.penalty_attack) atk += perks.penalty_attack;
    if (user.loots?.includes('midas_touch')) spd = Math.floor(spd * 0.3);
    if (user.loots?.includes('projection_sorcery')) spd = Math.floor(spd * 1.6);
    if (user.loots?.includes('blood_manipulation')) { atk = Math.floor(atk * 1.25); def = Math.floor(def * 1.25); }
    if (user.heavenly_restriction) { atk = Math.max(atk, 90); def = Math.max(def, 70); }
    return { attack: Math.min(MAX_ATTACK, Math.round(atk)), defense: Math.min(MAX_DEFENSE, Math.round(def)), speed: Math.min(MAX_SPEED, Math.round(spd)) };
}

  function recalcStats(user) {
     if (!user) return;
     const baseHP = 120;
     const baseCE = 100;
     const trained = user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0 };
     user.stats.Max_HP = baseHP + (trained.max_hp || 0);
     const armor = user.equipment?.armor;
     const ceBoost = (armor && armor !== 'None' && armor.effect?.type === 'max_ce_boost') ? (armor.effect.value || 0) : 0;
     user.stats.Max_CE = baseCE + (trained.max_ce || 0) + ceBoost;
     if (user.stats.HP > user.stats.Max_HP) user.stats.HP = user.stats.Max_HP;
     if (user.stats.CE > user.stats.Max_CE) user.stats.CE = user.stats.Max_CE;
     // Clear equipment-dependent temporary flags when equipment changes
     if (user._dharma_stacks !== undefined) {
         const hasDharma = armor && armor !== 'None' && armor.effect?.type === 'dharma_armor';
         if (!hasDharma) user._dharma_stacks = 0;
     }
     if (user._shroud_counter_used && (!armor || armor === 'None' || armor.effect?.type !== 'sukuna_shroud')) {
         user._shroud_counter_used = false;
     }
 }

function getTitlePerks(title) {
    return TITLE_PERKS[title] || {};
}

function rollRarity(minRarity = 'common') {
    const tiers = RARITY_TIERS;
    const minIndex = tiers.findIndex(t => t.id === minRarity);
    const roll = Math.random();
    let rarityIndex = 0;
    if (roll < 0.01) rarityIndex = 5;
    else if (roll < 0.05) rarityIndex = 4;
    else if (roll < 0.15) rarityIndex = 3;
    else if (roll < 0.35) rarityIndex = 2;
    else if (roll < 0.70) rarityIndex = 1;
    else rarityIndex = 0;
    if (rarityIndex < minIndex) rarityIndex = minIndex;
    return tiers[rarityIndex];
}

function generateEquipment(name, minRarity = 'common') {
    const base = EQUIPMENT_DB[name];
    if (!base) return null;
    const rarity = rollRarity(minRarity);
    const stats = {};
    if (base.baseAttack > 0) stats.attack = Math.floor(base.baseAttack * rarity.statMult);
    if (base.baseDefense > 0) stats.defense = Math.floor(base.baseDefense * rarity.statMult);
    return {
        id: Date.now() + Math.random(),
        name,
        type: base.type,
        slot: base.slot,
        rarity: rarity.id,
        rarityName: rarity.name,
        rarityColor: rarity.color,
        stats,
        durability: 100
    };
}

function applySkillTreeBonuses(user) {
    if (!user.unlocked_skills) return;
    // Roll back previously-applied skill contributions so re-running is idempotent (no stacking).
    if (user._skillHpBonus) { user.stats.Max_HP = Math.max(1, user.stats.Max_HP - user._skillHpBonus); user.stats.HP = Math.min(user.stats.HP || 0, user.stats.Max_HP); user._skillHpBonus = 0; }
    if (user._skillCeBonus) { user.stats.Max_CE = Math.max(1, user.stats.Max_CE - user._skillCeBonus); user._skillCeBonus = 0; }
    user._bonus_attack = 0;
    user._bonus_crit = 0;
    user._bonus_tech = 0;
    user._damage_reduction = 0;
    user._skills = {};
    const trees = SKILL_TREES;
    Object.values(trees).forEach(tree => {
        Object.entries(tree.skills).forEach(([key, skill]) => {
            if (user.unlocked_skills.includes(key)) {
                applySkillEffect(user, skill);
            }
        });
    });
}

// Applies both persistent stat changes (attack/HP/CE/crit/tech/reduction) and records
// the dynamic in-combat effects (low-hp buff, execute, combo, ce cost, etc.) into user._skills.
function applySkillEffect(user, skill) {
    const val = skill.value;
    user._skills = user._skills || {};
    switch (skill.effect) {
        case 'attack_flat':
            user._bonus_attack = (user._bonus_attack || 0) + val;
            break;
        case 'crit_chance':
            user._bonus_crit = (user._bonus_crit || 0) + val;
            break;
        case 'technique_damage':
            user._bonus_tech = (user._bonus_tech || 0) + val;
            break;
        case 'max_hp':
            user.stats.Max_HP += val;
            user._skillHpBonus = (user._skillHpBonus || 0) + val;
            user.stats.HP = Math.min(user.stats.HP || 0, user.stats.Max_HP);
            break;
        case 'max_ce':
            user.stats.Max_CE += val;
            user._skillCeBonus = (user._skillCeBonus || 0) + val;
            break;
        case 'damage_reduction':
            user._damage_reduction = (user._damage_reduction || 0) + val;
            break;
        // ── Dynamic in-combat effects (read during battle) ──
        case 'low_hp_buff':
            user._skills.low_hp_buff = (user._skills.low_hp_buff || 0) + val; break;
        case 'execute_damage':
            user._skills.execute_damage = (user._skills.execute_damage || 0) + val; break;
        case 'combo_damage':
            user._skills.combo_damage = (user._skills.combo_damage || 0) + val; break;
        case 'ce_reduction':
            user._skills.ce_reduction = (user._skills.ce_reduction || 0) + val; break;
        case 'technique_speed':
            user._skills.technique_speed = (user._skills.technique_speed || 0) + val; break;
        case 'technique_crit':
            user._skills.technique_crit = (user._skills.technique_crit || 0) + val; break;
        case 'max_technique':
            user._skills.max_technique = (user._skills.max_technique || 0) + val; break;
        case 'passive_heal':
            user._skills.passive_heal = (user._skills.passive_heal || 0) + val; break;
        case 'survival':
            user._skills.survival = (user._skills.survival || 0) + val; break;
    }
}

  function getCombatStats(user) {
    const base = calcPower(user);
    const trained = user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0 };
    let attack = base.attack + trained.attack;
    let defense = base.defense + trained.defense;
    if (user._bonus_crit) user._combat_crit_chance = (user._combat_crit_chance || 0.05) + user._bonus_crit;
    if (user._bonus_tech) user._combat_tech_bonus = (user._combat_tech_bonus || 0) + user._bonus_tech;
    if (user._damage_reduction) defense = Math.floor(defense * (1 + user._damage_reduction));
    // ARMOR: Grade 2 Tactical Trenchcoat — +20% defense after 5 turns.
    const trenchcoatBonus = getArmorEffect(user, 'defense_after_turns');
    if (trenchcoatBonus && (user.combat_state?.round || 0) >= 5) defense = Math.floor(defense * (1 + trenchcoatBonus));
    // ARMOR: Toji's Heavenly Restriction Ward — +35% physical damage.
    const tojiBonus = getArmorEffect(user, 'toji_ward');
    if (tojiBonus) attack = Math.floor(attack * 1.35);
    // ARMOR: Divine General's Dharma Armor — +25% defense per turn vs same enemy, stacks to 100%.
    const dharmaValue = getArmorEffect(user, 'dharma_armor');
    if (dharmaValue && user._dharma_stacks !== undefined) {
        const stackBonus = Math.min(user._dharma_stacks * dharmaValue, 1.0);
        defense = Math.floor(defense * (1 + stackBonus));
    }
    // Berserker: +X% attack when below 30% HP.
    if (user._skills?.low_hp_buff && (user.stats.HP || 0) < (user.stats.Max_HP || 1) * 0.3) {
        attack = Math.floor(attack * (1 + user._skills.low_hp_buff));
    }
    const weapon = user.equipment?.weapon;
    const armor = user.equipment?.armor;
    const accessory = user.equipment?.accessory;
    const relic = user.equipment?.relic;
    if (weapon && weapon.stats?.attack) attack += weapon.stats.attack;
    if (armor && armor.stats?.defense) defense += armor.stats.defense;
    if (accessory && accessory.stats?.attack) attack += accessory.stats.attack;
    if (relic && relic.stats?.attack) attack += relic.stats.attack;
    if (user.loots?.includes('limitless_six_eyes')) attack = Math.min(MAX_ATTACK, Math.floor(attack * 50));
    if (user.loots?.includes('king_of_curses') && (user.grade ?? 4) === 0) attack = Math.min(MAX_ATTACK, Math.floor(attack * 4));
    if (user.loots?.includes('projection_sorcery')) attack = Math.floor(attack * 0.45); // -55% STRENGTH
    if (user.loots?.includes('sovereigns_core')) attack = Math.floor(attack * 1.35); // +35% CE output
    return { attack: Math.min(MAX_ATTACK, attack), defense: Math.min(MAX_DEFENSE, defense), speed: Math.min(MAX_SPEED, base.speed) };
}

function checkAchievements(user) {
    if (!user.achievements) user.achievements = [];
    const newAchievements = [];
    Object.entries(ACHIEVEMENT_DEFS).forEach(([key, ach]) => {
        if (!user.achievements.includes(key) && ach.condition(user)) {
            user.achievements.push(key);
            newAchievements.push(ach.name);
        }
    });
    return newAchievements;
}

function calculateGrade(level) {
    let grade = 4;
    let nextThreshold = 10;
    let increment = 10;
    while (grade > 0 && level >= nextThreshold) {
        grade--;
        increment *= 2;
        nextThreshold += increment;
    }
    return grade;
}

function checkLevelUp(user) {
    if (!user) return false;
    let leveled = false;
    let guard = 0;
    while (user.xp >= user.xp_needed && user.level < MAX_LEVEL && guard < 2000) {
        user.xp -= user.xp_needed;
        user.level += 1;
        user.xp_needed = 30000 + 1000 * Math.pow(user.level, 2);
        user.skill_points = (user.skill_points || 0) + 1;
        recalcStats(user);
        user.grade = calculateGrade(user.level);
        if (user.grade <= 2) {
            user.unlocked_features = user.unlocked_features || {};
            user.unlocked_features.Domain = true;
        }
        leveled = true;
        guard++;
    }
    if (user.level >= MAX_LEVEL || guard >= 2000) user.xp = 0;
    return leveled;
}

function awardTitle(user, title) {
    if (!user.title_perks_active) user.title_perks_active = [];
    user.title = title;
    const perks = getTitlePerks(title);
    Object.entries(perks).forEach(([key, value]) => {
        user.title_perks_active.push({ title, perk: key, value });
    });
}

function initPlayer(jid, alignment, technique = null) {
    if (!technique) technique = getRandomTechnique(alignment);
    const moves = INNATE_TECHNIQUES[technique]?.moves || {};
    db.users[jid] = {
        player_id: jid, name: jidDecode(jid)?.user || jid.split('@')[0], alignment: alignment === 'Curse' ? 'Curse User' : alignment, grade: 4, level: 1, xp: 0, xp_needed: 30000,
        title: 'None',
        stats: { HP: 120, Max_HP: 120, CE: 100, Max_CE: 100, Output: 1.0, Refinement: 10 },
        skill_points: 0,
        trained_stats: { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 },
        equipment: { weapon: 'None', armor: 'None', accessory: 'None', relic: 'None' },
        summon: { active: false, name: 'None', HP: 0, Max_HP: 0, type: 'None' },
        shop: { has_shop: false, node: 'None', name: 'None', inventory: [], vault: 0 },
        current_node: 'Tokyo Jujutsu High Hub',
        innate_technique_id: technique,
        skills: moves,
        unlocked_skills: [],
        tree_path: null,
        unlocked_features: { RCT: false, Domain: false, Simple_Domain: false },
        active_status_effects: [],
        gold: 500, wallet: 500, bank: 0, lastDaily: 0, last_heal: 0, last_fish: 0, registered: true, command_count: 0,
        combat_state: { in_combat: false, target: {}, phase: 0, is_ambush: false, field_hazard: 'None', combo: 0, break_charge: 0, counter_state: false },
        damage_taken: 0,
        consecutive_wins: 0,
        technique_1: Object.keys(moves)[0],
        technique_2: Object.keys(moves)[1],
        technique_3: Object.keys(moves)[2],
        technique_4: Object.keys(moves)[3],
        weapon: null,
        weapons_owned: [],
        wa_attack: 6,
        heavenly_restriction: false,
        stalker_curse: null,
        active_curse_spawn: null,
        inventory: [],
        discovered_locations: ['Tokyo Jujutsu High Hub'],
        reputation: { 'Jujutsu High': 0, 'Geto Cult': 0, 'Civilians': 0 },
        active_quest: null,
        quest_log: [],
        loser_until: 0,
        achievements: [],
        title_perks_active: [],
        dungeon_state: null,
        guild_id: null,
        combo_god_until: 0,
        domain: null,
        domain_await_confirm: false,
        domain_await_name: false,
        corruption: 0,
        quirks: [],
        prisonRealm: null,
        sanity: 100,
        stance: 100,
        distance: 5
    };
    if (!db.userSkills) db.userSkills = {};
    if (!db.userSkills[jid]) db.userSkills[jid] = [];
    recalcStats(db.users[jid]);
    saveDb();
    return db.users[jid];
}

function migrateUser(user) {
    let changed = false;
    const defaults = {
        name: user.name || user.username || user.player_id?.split('@')[0] || 'Unknown',
        alignment: user.alignment || 'Sorcerer',
        grade: user.grade ?? 4,
        level: user.level ?? 1,
        xp: user.xp ?? 0,
        xp_needed: user.xp_needed ?? 30000 + 1000 * Math.pow((user.level ?? 1), 2),
        title: user.title || 'None',
        stats: user.stats || { HP: 120, Max_HP: 120, CE: 100, Max_CE: 100, Output: 1.0, Refinement: 10 },
        equipment: user.equipment || { weapon: 'None', armor: 'None', accessory: 'None', relic: 'None' },
        summon: user.summon || { active: false, name: 'None', HP: 0, Max_HP: 0, type: 'None' },
        shop: user.shop || { has_shop: false, node: 'None', name: 'None', inventory: [], vault: 0 },
        current_node: user.current_location || user.current_node || 'Tokyo Jujutsu High Hub',
        innate_technique_id: user.innate_technique_id || 'Tag Youre It',
        skills: user.skills || user.innate_technique_id ? (INNATE_TECHNIQUES[user.innate_technique_id]?.moves || {}) : {},
        unlocked_skills: user.unlocked_skills || [],
        tree_path: user.tree_path || null,
        unlocked_features: user.unlocked_features || { RCT: false, Domain: false, Simple_Domain: false },
        active_status_effects: user.active_status_effects || [],
        gold: user.gold ?? 500,
        wallet: user.wallet ?? 500,
        bank: user.bank ?? 0,
        lastDaily: user.lastDaily ?? 0,
        last_heal: user.last_heal ?? 0,
        last_fish: user.last_fish ?? 0,
        registered: user.registered ?? true,
        command_count: user.command_count ?? 0,
        combat_state: user.combat_state || { in_combat: false, target: {}, phase: 0, is_ambush: false, field_hazard: 'None', combo: 0, break_charge: 0, counter_state: false },
        damage_taken: user.damage_taken ?? 0,
        consecutive_wins: user.consecutive_wins ?? 0,
        technique_1: user.technique_1 || Object.keys(user.skills || {})[0],
        technique_2: user.technique_2 || Object.keys(user.skills || {})[1],
        technique_3: user.technique_3 || Object.keys(user.skills || {})[2],
        technique_4: user.technique_4 || Object.keys(user.skills || {})[3],
        weapon: user.weapon || null,
        weapons_owned: user.weapons_owned || [],
        wa_attack: user.wa_attack ?? 6,
        heavenly_restriction: user.heavenly_restriction || false,
        stalker_curse: user.stalker_curse || null,
        active_curse_spawn: user.active_curse_spawn || null,
        inventory: user.inventory || [],
        discovered_locations: user.discovered_locations || ['Tokyo Jujutsu High Hub'],
        reputation: user.reputation || { 'Jujutsu High': 0, 'Geto Cult': 0, 'Civilians': 0 },
        active_quest: user.active_quest || null,
        quest_log: user.quest_log || [],
        loser_until: user.loser_until ?? 0,
        achievements: user.achievements || [],
        title_perks_active: user.title_perks_active || [],
        dungeon_state: user.dungeon_state || null,
        guild_id: user.guild_id || null,
        clan: user.clan || null,
        combo_god_until: user.combo_god_until || 0,
        corruption: user.corruption ?? 0,
        skill_points: user.skill_points || 0,
        trained_stats: user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 },
        quirks: user.quirks || [],
        prisonRealm: user.prisonRealm || null,
        sanity: user.sanity ?? 100,
        stance: user.stance ?? 100,
        distance: user.distance ?? 5
    };
    Object.keys(defaults).forEach(key => {
        if (user[key] !== defaults[key]) {
            user[key] = defaults[key];
            changed = true;
        }
    });
    if (user.stats.HP === null || user.stats.HP === undefined) { user.stats.HP = user.stats.Max_HP || 120; changed = true; }
    if (user.stats.CE === null || user.stats.CE === undefined) { user.stats.CE = user.stats.Max_CE || 100; changed = true; }
    recalcStats(user);
    // Recompute skill-derived bonuses/effects so combat reads them correctly.
    applySkillTreeBonuses(user);
    return changed;
}

function ensureWorldState() {
    if (!db.world) {
        db.world = {
            timeOfDay: 'day',
            globalEvents: [],
            districtDanger: {},
            lastEventRoll: Date.now()
        };
    }
    Object.keys(TOKYO_MAP).forEach(loc => {
        if (!db.world.districtDanger[loc]) {
            db.world.districtDanger[loc] = TOKYO_MAP[loc].danger;
        }
    });
}

function ensureShopState() {
    if (!db.shops) db.shops = {};
}

function processStatusEffects(user) {
    for (const status of user.active_status_effects) {
        if (status.dot) user.stats.HP -= status.dot;
        status.turns = (status.turns || 1) - 1;
    }
    user.active_status_effects = user.active_status_effects.filter(s => s.turns > 0);
}

function hasStatus(user, name) { return user?.active_status_effects?.some(s => s.name === name) || false; }

// A full heal (`.heal`) must purge damage-over-time afflictions (Bleed / Rot / etc.)
// or the user will simply bleed out again after being restored — making the heal appear
// to "not work". RECOVERY (a death penalty) is intentionally left intact.
function clearDoTStatuses(user, combat) {
    if (user && Array.isArray(user.active_status_effects)) {
        user.active_status_effects = user.active_status_effects.filter(s => {
            if (!s) return false;
            const hasDot = s.dot || s.damage_per_turn || s.dot_damage || s.tick_damage;
            const isDoT = hasDot || (s.effect && String(s.effect).toLowerCase().includes('bleed')) || (s.effect && String(s.effect).toLowerCase().includes('poison')) || (s.effect && String(s.effect).toLowerCase().includes('rot')) || (s.effect && String(s.effect).toLowerCase().includes('burn'));
            return !isDoT;
        });
    }
    if (combat && Array.isArray(combat.playerStatus)) {
        combat.playerStatus = combat.playerStatus.filter(s => {
            if (!s) return false;
            const hasDot = s.dot || s.damage_per_turn || s.dot_damage || s.tick_damage;
            const isDoT = hasDot || (s.effect && String(s.effect).toLowerCase().includes('bleed')) || (s.effect && String(s.effect).toLowerCase().includes('poison')) || (s.effect && String(s.effect).toLowerCase().includes('rot')) || (s.effect && String(s.effect).toLowerCase().includes('burn'));
            return !isDoT;
        });
    }
}

function processDefeat(user, mode = 'standard') {
    if (mode === 'shaman_purge') {
        delete db.users[user.player_id];
        if (db.combats[user.player_id]) delete db.combats[user.player_id];
        saveDb();
        return `💀 [CHRONICLE TERMINATED] 💀\n───\nYour Cursed Energy has completely dissipated from the physical plane.\n───\n*Type \`.start\` to birth a new lineage.*`;
    }
    user.stats.HP = 0;
    user.current_node = 'Tokyo Jujutsu High Hub';
    const xpLoss = Math.floor(user.xp_needed * 0.5);
    user.xp = Math.max(0, user.xp - xpLoss);
    user.active_status_effects.push({ name: 'RECOVERY', turns: 600 });
    if (db.combats[user.player_id]) delete db.combats[user.player_id];
    saveDb();
    return `You were defeated and sent to Tokyo Jujutsu High Hub.\nLost ${xpLoss} XP.\n[RECOVERY] status - cannot explore for 10 minutes.`;
}

function checkIncursion(user) {
    if (user.stats.HP < 40 && !hasStatus(user, 'RECOVERY')) {
        const ambushGrade = Math.max(0, getEffectiveGrade(user) + 1);
        const loc = pick(Object.keys(TOKYO_MAP));
        return {
            active: true, location: loc,
            enemy: { name: 'Ambush Curse', grade: ambushGrade, stats: { HP: 100, Max_HP: 100, CE: 80 }, technique: CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)], skills: INNATE_TECHNIQUES[CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)]]?.moves || {} }
        };
    }
    return { active: false };
}

 function recordCurseDefeat(user, enemy) {
    if (!user || !enemy) return;
    user._copied_techniques = user._copied_techniques || [];
    user._cursed_army = user._cursed_army || [];
    const enemySkills = enemy.skills || INNATE_TECHNIQUES[enemy.technique]?.moves || {};
    const skillKeys = Object.keys(enemySkills);
    const isHR = !!enemy.heavenly_restriction;
    if (!isHR && skillKeys.length > 0) {
        let bestKey = skillKeys[0];
        let bestDmg = enemySkills[bestKey]?.damage || 0;
        for (const key of skillKeys) {
            const d = enemySkills[key]?.damage || 0;
            if (d > bestDmg) { bestDmg = d; bestKey = key; }
        }
        const move = enemySkills[bestKey];
        user._copied_techniques = [{ ...move, name: move?.name || bestKey, _key: bestKey }];
    }
    const isCurse = enemy.name?.toLowerCase().includes('curse') || enemy.name?.toLowerCase().includes('spirit') || !!enemy.technique;
    if (isCurse) {
        user._cursed_army.push({ name: enemy.name, grade: enemy.grade });
    }
}

function getLeaderboard() {
    const users = Object.values(db.users).sort((a,b)=> (b.level||0)-(a.level||0) || (b.xp||0)-(a.xp||0)).slice(0,10);
    let msg = '🏆 **KENNYJAKS GLOBAL RADAR LEADERBOARD** 🏆\n───';
    users.forEach((u,i)=> {
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'> ';
        const name = u.name || u.player_id?.split('@')[0] || 'Unknown';
        msg += `\n${medal} **${i+1}.** ${name}\n> Level: ${u.level || 0} | Grade: ${u.grade || 0} | XP: ${fmtNum(u.xp || 0)}`;
        if (i<users.length-1) msg += '\n───';
    });
    return msg + '\n───\n*Type `.p` to inspect your personal standing and active title parameters.*';
}

function getAllPlayers() {
    const users = Object.values(db.users).filter(u => u.registered).sort((a,b)=> (b.level||0)-(a.level||0) || (b.xp||0)-(a.xp||0));
    if (!users.length) return '📭 No players registered yet.';
    let msg = `👥 *ALL PLAYERS (${users.length})*\n───`;
    users.forEach((u,i)=> {
        const name = u.name || u.player_id?.split('@')[0] || 'Unknown';
        const gradeName = GRADE_NAMES[u.grade] || 'Grade 4';
        msg += `\n${i+1}. *${name}*\n> Level: ${u.level || 0} | Grade: ${gradeName} | XP: ${fmtNum(u.xp || 0)}`;
        if (i<users.length-1) msg += '\n───';
    });
    return msg;
}

function getLeaderboardRaw() {
    return Object.values(db.users)
        .map(u => ({ jid: u.player_id, name: u.name || u.player_id?.split('@')[0] || 'Unknown', level: u.level || 0, xp: u.xp || 0 }))
        .sort((a, b) => (b.level || 0) - (a.level || 0) || (b.xp || 0) - (a.xp || 0));
}

function rollWorldEvent() {
    const now = Date.now();
    if (db.world && db.world.lastEventRoll && (now - db.world.lastEventRoll < 30 * 60 * 1000)) return null;
    if (Math.random() > 0.25) return null;
    const events = [
        { name: 'Curse Outbreak', effect: 'danger', msg: 'A curse outbreak is spreading through {loc}! Danger increased.' },
        { name: 'Jujutsu Sweep', effect: 'safe', msg: 'Jujutsu High conducted a sweep in {loc}. Danger decreased.' },
        { name: 'Geto Rally', effect: 'danger', msg: 'Cult activity spiked in {loc}. Be careful.' }
    ];
    const event = pick(events);
    const loc = pick(Object.keys(TOKYO_MAP));
    event.msg = event.msg.replace('{loc}', loc);
    if (db.world) {
        db.world.lastEventRoll = now;
        db.world.globalEvents = db.world.globalEvents || [];
        db.world.globalEvents.push({ ...event, location: loc, time: now });
        if (db.world.globalEvents.length > 20) db.world.globalEvents.shift();
    }
    return event;
}

function formatUI(user, enemy, round, location) {
    const p = calcPower(user);
    const enemyName = enemy?.name || 'None';
    const enemyHP = enemy?.stats?.HP || 0;
    const enemyMaxHP = enemy?.stats?.Max_HP || 0;
    const summonActive = user.summon?.active;
    const summonName = summonActive ? user.summon.name : 'None';
    const summonHP = summonActive ? `${user.summon.HP}/${user.summon.Max_HP}` : '0/0';
    const hazard = user.combat_state?.field_hazard || 'None';
    return `╔════════════════════════════════════════╗\n   𝔎𝔈𝔑𝔎𝔈𝔑𝔑𝔜𝔍𝔔𝔎𝔖 : 𝔅𝔄𝔗𝔗𝔏𝔈 𝔉𝔖𝔗𝔄𝔗𝔈\n╚════════════════════════════════════════╝\n 🌐 ZONE: ${location}\n 👤 SORCERER: ${user.name} | 🩺 ${user.stats.HP}/${user.stats.Max_HP} | ⚡ ${ceFor(user)} CE\n 🐾 SUMMON: ${summonName} | 🩺 ${summonHP} HP\n 👾 HOSTILE: ${enemyName} | 🩺 ${enemyHP}/${enemyMaxHP}\n──────────────────────────────────────────\n ⚔️ COMBAT CHRONICLE:\n 🧑‍🎓 PLAYER: Awaiting action...\n 💥 OUTPUT: -\n\n 👹 RETRIBUTION: -\n ☠️ IMPACT: -\n──────────────────────────────────────────\n 📊 SYSTEM DELTA: CE: 0 | Enemy HP: 0 | Player HP: 0\n╚════════════════════════════════════════╝\n*Action Paths:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .ut-1 | .ut-2 | .ut-3 | .ut-4 | .rct [val] | .domain`;
}

function fmtNum(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function getCinematicPlayerDescription(actionType, techKey, damage, isCrit) {
    const crit = isCrit ? ' with a devastating critical impact' : '';
    const baseActions = {
        attack: [
            `Launched a ferocious closed-fist strike that cracked the air${crit}.`,
            `Rushed forward with a brutal palm thrust, landing true${crit}.`,
            `Unleashed a rapid jab combination forcing the target to stagger${crit}.`,
            `Delivered a crushing roundhouse kick that echoed through the zone${crit}.`,
            ` lunged with a piercing elbow strike, finding its mark${crit}.`
        ],
        technique: [
            `Channeled cursed energy into a focused technique blast${crit}.`,
            `Weaved cursed energy into a sharp signature technique${crit}.`,
            `Triggered a condensed cursed energy release${crit}.`,
            `Executed a precise cursed technique manifestation${crit}.`
        ]
    };
    const pool = baseActions[actionType] || baseActions.attack;
    return pick(pool);
}

function getCinematicEnemyDescription(enemyName, skills, damage) {
    const skillKeys = Object.keys(skills || {});
    const skillName = skillKeys.length > 0 ? getTechDisplayName(pick(skillKeys)) : 'cursed energy strike';
    const templates = [
        `${enemyName} retaliated with a brutal ${skillName}, tearing into its target.`,
        `${enemyName} unleashed a wicked ${skillName}, forcing a desperate response.`,
        `${enemyName} lashed out with ${skillName}, its curse energy biting deep.`,
        `${enemyName} counterattacked using ${skillName}, the blow landing with brutal force.`
    ];
    return pick(templates);
}

// ── Interactive combat system ──
// Enemies now act with intent (telegraphed), apply status effects, and can brace/charge.
const ENEMY_MOVE_POOL = [
    { id: 'strike', label: 'Cursed Strike', kind: 'attack', weight: 28, mult: 1.0 },
    { id: 'maul', label: 'Savage Maul', kind: 'attack', weight: 16, mult: 1.7, status: { type: 'BLEED', name: 'Bleeding', dot: 0.10, turns: 2 } },
    { id: 'venom', label: 'Venomous Bite', kind: 'attack', weight: 14, mult: 0.7, status: { type: 'BLEED', name: 'Bleeding', dot: 0.08, turns: 2 } },
    { id: 'wither', label: 'Withering Aura', kind: 'debuff', weight: 12, mult: 0.4, status: { type: 'WEAKEN', name: 'Weakened', value: 0.25, turns: 2 } },
    { id: 'blind', label: 'Blindfold Veil', kind: 'debuff', weight: 10, mult: 0.5, status: { type: 'BLIND', name: 'Blinded', value: 0.3, turns: 1 } },
    { id: 'guard', label: 'Cursed Guard', kind: 'defend', weight: 10 },
    { id: 'charge', label: 'Malevolent Charge', kind: 'charge', weight: 8, mult: 2.6 }
];

function pickEnemyMove() {
    const total = ENEMY_MOVE_POOL.reduce((s, m) => s + m.weight, 0);
    let r = Math.random() * total;
    for (const m of ENEMY_MOVE_POOL) { r -= m.weight; if (r <= 0) return m; }
    return ENEMY_MOVE_POOL[0];
}

function enemyIntentHint(move) {
    switch (move.kind) {
        case 'attack': return `${move.label} — a direct strike is inbound.`;
        case 'charge': return `${move.label} — it's winding up a DEVASTATING blow! Use .guard now!`;
        case 'defend': return `${move.label} — it's bracing, your next hit will be weakened.`;
        case 'debuff': return `${move.label} — it's trying to inflict ${move.status.name}.`;
        default: return move.label;
    }
}

function getEnemyDomainName(enemy) {
    const domains = [
        'Malevolent Shrine', 'Coffin of the Iron Mountain', 'Chimera Shadow Garden',
        'Horizon of the Captivating Skandha', 'Self-Embodiment of Perfection',
        'Womb Profusion', 'Deadly Sentencing Hollow', 'Void of Endless Hunger'
    ];
    if (!enemy._domainName) enemy._domainName = pick(domains);
    return enemy._domainName;
}

function combatHasStatus(combat, type) { return (combat.playerStatus || []).some(s => s.type === type); }

function applyCombatStatus(combat, status) {
    combat.playerStatus = combat.playerStatus || [];
    const ex = combat.playerStatus.find(s => s.type === status.type);
    if (ex) {
        ex.turns = Math.max(ex.turns, status.turns);
        if (status.value != null) ex.value = Math.max(ex.value || 0, status.value);
        if (status.dot != null) ex.dot = Math.max(ex.dot || 0, status.dot);
        if (status.name) ex.name = status.name;
    } else {
        combat.playerStatus.push({ ...status });
    }
}

function tickCombatStatus(combat, user) {
    combat.playerStatus = combat.playerStatus || [];
    const lines = [];
    for (const s of combat.playerStatus) {
        if (s.type === 'BLEED' && s.dot) {
            const dmg = Math.max(1, Math.floor(user.stats.Max_HP * s.dot));
            user.stats.HP -= dmg;
            lines.push(`-${dmg} HP`);
        }
        s.turns -= 1;
    }
    combat.playerStatus = combat.playerStatus.filter(s => s.turns > 0);
    if (user.stats.HP <= 0) user.stats.HP = 1;
    
    // Environmental tick for Dark Continent
    if (combat.darkRegion) {
        const region = db.darkContinent?.regions?.[combat.regionId];
        if (region?.environmental) {
            const env = region.environmental;
            if (env.effect === 'decay') {
                const hpDrain = Math.max(1, Math.floor(user.stats.Max_HP * (env.hpDrain || 0.03)));
                const ceDrain = Math.max(1, Math.floor(user.stats.Max_CE * (env.ceDrain || 0.03)));
                user.stats.HP = Math.max(1, user.stats.HP - hpDrain);
                user.stats.CE = Math.max(0, user.stats.CE - ceDrain);
                lines.push(`☣️ ${env.name}: -${hpDrain} HP, -${ceDrain} CE`);
            } else if (env.effect === 'sanity_drain') {
                user.sanity = Math.max(0, (user.sanity || 100) - (env.sanityDrain || 5));
                lines.push(`🧠 Sanity: ${user.sanity}%`);
                if (user.sanity < 40 && Math.random() < 0.3) {
                    combat.hallucination = true;
                    lines.push(`👁️ HALLUCINATION: You see false enemies!`);
                }
            } else if (env.effect === 'distance_pull') {
                combat.distance = Math.min(50, (combat.distance || 5) + (env.distanceIncrease || 10));
                lines.push(`💨 Void Winds: Distance increased to ${combat.distance}m`);
            }
        }
    }
    
    // Stance recovery
    if (user.stanceBroken) {
        user.stanceBreakTurns = (user.stanceBreakTurns || 1) - 1;
        if (user.stanceBreakTurns <= 0) {
            user.stanceBroken = false;
            user.stanceBreakTurns = 0;
            user.stance = 100;
            lines.push(`🛡️ Stance recovered!`);
        }
    }
    
    // Panic state at 0% sanity
    if (user.sanity <= 0 && !user.active_status_effects?.find(s => s.name === 'PANIC')) {
        user.active_status_effects = user.active_status_effects || [];
        user.active_status_effects.push({ name: 'PANIC', turns: 999, evasion: 0, damageTakenMult: 1.5 });
        lines.push(`😱 PANIC! Sanity depleted!`);
    }
    
    // Ecological Chaos: random events in Dark Continent
    if (combat.darkRegion && Math.random() < 0.08) {
        const chaosEvents = [
            { name: 'Gravity Inversion', effect: 'gravity', desc: 'Gravity flips! Melee attacks miss for 2 turns. Projectiles deal 2x.', turns: 2 },
            { name: 'CE Storm', effect: 'ce_storm', desc: 'A cursed energy storm ravages the area! Both sides lose 15% CE per turn.', ceDrain: 0.15 },
            { name: 'Soul Siphon', effect: 'soul_siphon', desc: 'A spectral vortex drains HP from both combatants. -10% Max HP.', hpDrain: 0.10 },
            { name: 'Cursed Resonance', effect: 'resonance', desc: 'Resonant frequency amplifies all damage by 25% for 3 turns.', damageMult: 1.25, turns: 3 },
            { name: 'Void Rift', effect: 'void_rift', desc: 'A spatial rift opens! Distance randomized.', distanceRandom: true }
        ];
        const event = chaosEvents[Math.floor(Math.random() * chaosEvents.length)];
        combat.ecologicalEvent = event;
        lines.push(`⚠️ *ECOLOGICAL CHAOS: ${event.name}*\n${event.desc}`);
        
        // Apply immediate effects
        if (event.effect === 'gravity') {
            combat.gravityInversion = event.turns || 2;
        } else if (event.effect === 'ce_storm') {
            const ceDrain = Math.floor(user.stats.Max_CE * (event.ceDrain || 0.15));
            user.stats.CE = Math.max(0, user.stats.CE - ceDrain);
            lines.push(`⚡ CE Storm: -${ceDrain} CE`);
        } else if (event.effect === 'soul_siphon') {
            const hpDrain = Math.floor(user.stats.Max_HP * (event.hpDrain || 0.10));
            user.stats.HP = Math.max(1, user.stats.HP - hpDrain);
            lines.push(`👻 Soul Siphon: -${hpDrain} HP`);
        } else if (event.effect === 'resonance') {
            combat.damageMult = (combat.damageMult || 1) * (event.damageMult || 1.25);
            combat.resonanceTurns = event.turns || 3;
        } else if (event.effect === 'void_rift') {
            combat.distance = 5 + Math.floor(Math.random() * 20);
            lines.push(`🌀 Void Rift: Distance randomized to ${combat.distance}m`);
        }
    }
    
    return lines;
}

// ── PvP (player vs player) duel engine ──
// A challenged user accepts with .ch-a and a turn-by-turn duel begins.
// Each fighter's HP/CE/ATK/DEF/SPD are snapshotted from their real progression
// via getCombatStats() so stronger sorcerers have the edge, but CE + guarding
// keep weaker players in the fight.
function getPvpMatch(chat, jid) {
    const m = db.pvp[chat];
    if (!m || !m.started) return null;
    if (m.p1 === jid || m.p2 === jid) return m;
    return null;
}

function pvpDisplayName(jid) {
    const u = db.users[jid];
    return (u && u.name) ? u.name : (jidDecode(jid)?.user || jid.split('@')[0]);
}

function pvpBar(cur, max, len = 12, sym = '█') {
    const ratio = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
    const filled = Math.round(ratio * len);
    return sym.repeat(filled) + '░'.repeat(Math.max(0, len - filled));
}

function buildPvpStatus(match, note) {
    const a = match.players[match.p1], b = match.players[match.p2];
    const aName = pvpDisplayName(match.p1), bName = pvpDisplayName(match.p2);
    const turnName = pvpDisplayName(match.turn);
    const turnMark = (j) => (match.turn === j ? '▶️' : '⏸️');
    let line = `╔══════════════════════════════════════╗\n   𝔎𝔈ℕℕ𝔜𝔍𝔄𝔎𝔖 : 𝔓𝔙ℙ 𝔇𝔘𝔈ℒ\n╚══════════════════════════════════════╝\n`;
    line += `🥊 ROUND ${match.round} — ${turnMark(match.turn)} *${turnName}* to act\n`;
    line += `──────────────────────────────────────────\n`;
    line += `${turnMark(match.p1)} ${aName}\n`;
    line += `  ❤️ ${pvpBar(a.hp, a.maxhp)} ${Math.max(0, Math.round(a.hp))}/${a.maxhp}\n`;
    line += `  ⚡ ${pvpBar(a.ce, a.maxce, 12, '▮')} ${Math.max(0, Math.round(a.ce))}/${a.maxce}\n`;
    line += `${turnMark(match.p2)} ${bName}\n`;
    line += `  ❤️ ${pvpBar(b.hp, b.maxhp)} ${Math.max(0, Math.round(b.hp))}/${b.maxhp}\n`;
    line += `  ⚡ ${pvpBar(b.ce, b.maxce, 12, '▮')} ${Math.max(0, Math.round(b.ce))}/${b.maxce}\n`;
    line += `──────────────────────────────────────────\n`;
    if (note) line += `${note}\n`;
    line += `📊 *Actions:* .attack | .technique-1..4 | .guard | .rct [val] | .domain | .flee`;
    return line;
}

async function sendPvpStatus(sock, from, match, note) {
    await sock.sendMessage(from, { text: buildPvpStatus(match, note) });
}

async function startPvpMatch(sock, from, challenger, challenged) {
    const c = db.users[challenger], d = db.users[challenged];
    const cs = getCombatStats(c), ds = getCombatStats(d);
    const match = {
        p1: challenger,
        p2: challenged,
        turn: challenger,
        round: 1,
        started: true,
        committed: {},
        log: [],
        players: {
            [challenger]: {
                hp: c.stats.Max_HP, maxhp: c.stats.Max_HP,
                ce: c.stats.Max_CE, maxce: c.stats.Max_CE,
                atk: cs.attack, def: cs.defense, spd: cs.speed,
                guarding: false, dodgeNext: false, spec: c.innate_technique_id,
                name: pvpDisplayName(challenger)
            },
            [challenged]: {
                hp: d.stats.Max_HP, maxhp: d.stats.Max_HP,
                ce: d.stats.Max_CE, maxce: d.stats.Max_CE,
                atk: ds.attack, def: ds.defense, spd: ds.speed,
                guarding: false, dodgeNext: false, spec: d.innate_technique_id,
                name: pvpDisplayName(challenged)
            }
        }
    };
    db.pvp[from] = match;
    // Link a liberation duel: if one fighter accepted a village rebellion mission and the
    // other is that village's colonising clan head, the duel decides the village's fate.
    for (const [vid, v] of Object.entries(db.villages || {})) {
        if (v.rebellion && v.mission && v.mission.active && v.mission.acceptedBy) {
            const clan = findClanByName(v.coloniserClanName);
            const head = clan && clan.head;
            const lib = v.mission.acceptedBy;
            if ((challenger === lib && challenged === head) || (challenger === head && challenged === lib)) {
                match.villageMission = vid;
                match.villageLiberator = lib;
                break;
            }
        }
    }
    saveDb();
    const cName = pvpDisplayName(challenger), dName = pvpDisplayName(challenged);
    await sendPvpStatus(sock, from, match,
        `⚔️ *DUEL START!*\n${cName} (${c.alignment || 'Sorcerer'}) vs ${dName} (${d.alignment || 'Sorcerer'})\nBoth fighters, send your move — the higher SPEED lands first!`);
}

async function resolvePvpWinner(sock, from, match, winnerJid, loserJid, reason) {
    const w = db.users[winnerJid], l = db.users[loserJid];
    w.pvp_wins = (w.pvp_wins || 0) + 1;
    l.pvp_losses = (l.pvp_losses || 0) + 1;
    w.xp += 1500;
    w.wallet += 500;
    checkLevelUp(w);
    const wName = pvpDisplayName(winnerJid), lName = pvpDisplayName(loserJid);
    delete db.pvp[from];
    if (match.villageMission) {
        const v = db.villages[match.villageMission];
        if (v && v.mission && v.mission.active) {
            const lib = match.villageLiberator;
            if (winnerJid === lib) {
                const lu = db.users[lib];
                if (lu) lu.wallet += 30000000;
                v.colonisedBy = null; v.coloniserClanName = null; v.tax = 0; v.rebellion = false; v.mission = null; v.dailyTax = 0;
                broadcastNow(`🔥 *VILLAGE ${v.name.toUpperCase()} LIBERATED!* ${pvpDisplayName(lib)} defeated the clan head and freed the villagers, earning 30,000,000 K-Coins!`);
            } else {
                v.rebellion = false; v.mission = null;
                broadcastNow(`💀 *VILLAGERS OF ${v.name.toUpperCase()} EXECUTED.* ${pvpDisplayName(lib)} fell to the clan head — the rebellion is crushed.`);
            }
        }
    }

    // Prison Realm breakout: winner with Playful Cloud, Black Rope, or Limitless can free prisoners sealed by loser
    const winnerWeapon = w.weapon?.name || '';
    const winnerHasLimitless = w.loots?.includes('limitless_six_eyes');
    const canBreakSeals = winnerHasLimitless || winnerWeapon === 'Playful Cloud' || winnerWeapon === 'Black Rope';
    let sealBreakMsg = '';
    if (canBreakSeals) {
        const sealedUsers = Object.values(db.users || {}).filter(u => u.prisonRealm && Date.now() < (u.prisonRealm.releasedAt || 0) && u.prisonRealm.sealedBy === loserJid);
        if (sealedUsers.length > 0) {
            for (const su of sealedUsers) {
                su.prisonRealm = null;
                try { await sock.sendMessage(su.player_id, { text: `🔓 *PRISON REALM BROKEN!*\n${wName} defeated ${lName} in PvP using ${winnerWeapon || 'Limitless power'}!\nYou have been freed from the Prison Realm!`, mentions: [su.player_id] }); } catch {}
            }
            sealBreakMsg = `\n🔓 *PRISON REALM BROKEN!*\n${wName} freed ${sealedUsers.length} prisoner(s) sealed by ${lName}!`;
        }
    }

    // Culling Game: PvP knockout gives winner +50 points, loser is eliminated
    let cgMsg = '';
    const cg = db.cullingGame;
    if (cg?.active && cg.players[winnerJid] && cg.players[loserJid]) {
        const wCg = w.cullingGame || {};
        const lCg = l.cullingGame || {};
        wCg.points = (wCg.points || 0) + 50;
        wCg.lastPointChange = Date.now();
        delete cg.players[loserJid];
        lCg.points = 0;
        cgMsg = `\n🎯 *CULLING GAME KNOCKOUT!*\n${wName} +50 pts | ${lName} eliminated!`;
        try { await sock.sendMessage(loserJid, { text: `💀 *CULLING GAME — ELIMINATED*\nYou were knocked out of the Culling Game by ${wName}!\nYou have been removed from the barrier.`, mentions: [loserJid] }); } catch {}
    }

    saveDb();
    await sock.sendMessage(from, {
        text: `╔══════════════════════════════════════╗\n   𝔎𝔈ℕℕ𝔜𝔍𝔄𝔎𝔖 : 𝔓𝔙ℙ 𝔇𝔘𝔈ℒ — 𝔙𝔌ℂ𝔗𝔒ℝ𝔜\n╚══════════════════════════════════════╝\n🏆 *${wName}* defeated *${lName}*!\n───\n📝 ${reason}\n🎁 Reward: +1,500 XP, +500 Gold\n📊 ${wName} — ${w.pvp_wins}W / ${w.pvp_losses}L\n📊 ${lName} — ${l.pvp_wins}W / ${l.pvp_losses}L${sealBreakMsg}${cgMsg}`,
        mentions: [winnerJid, loserJid]
    });
}

function pvpCritChance(me, you) {
    return Math.min(0.5, 0.05 + (me.spd / (me.spd + you.spd || 1)) * 0.15);
}

// Returns true if it handled the command (so the caller should `continue`).
// Applies a player's defensive / self-only PvP action (Reverse Cursed Technique heal
// or Cursed Guard). Called at the start of a round so guards are active before either
// attack lands.
function pvpApplySelf(me, you, user, command, args) {
    if (command === 'guard') {
        me.guarding = true;
        me.ce = Math.min(me.maxce, me.ce + 20);
        return { kind: 'guard', note: `🛡️ ${me.name} braced behind a Cursed Guard (+20 CE, next hit −55%)` };
    }
    if (command === 'rct') {
        if (user.heavenly_restriction) return { kind: 'error', note: '💀 *HEAVENLY RESTRICTION:* You have no cursed energy — RCT is impossible.' };
        let amt = parseInt(args[0]) || 30;
        amt = Math.max(1, Math.min(amt, Math.floor(me.ce)));
        const healed = Math.min(amt, me.maxhp - me.hp);
        me.hp += healed;
        me.ce -= healed;
        return { kind: 'rct', note: `⚡ ${me.name} used Reverse Cursed Technique: +${healed} HP (cost ${healed} CE)`, healed };
    }
    if (command === 'jk') {
        if (!user.loots?.includes('jackpot')) return { kind: 'error', note: '🎰 *JACKPOT LOCKED.*' };
        me.hp = me.maxhp;
        me.ce = me.maxce;
        me._jackpot_until = (me._jackpot_until || 0) + 360000;
        if (!user.unlocked_features?.RCT) {
            user.unlocked_features.RCT = true;
            user.stats.HP = 1;
        }
        return { kind: 'jackpot', note: `🎰 ${me.name} activated JACKPOT! Infinite HP/CE for 6 minutes. RCT permanently unlocked!` };
    }
    if (command === 'taunt') {
        if (!user.loots?.includes('honoured_one')) return { kind: 'error', note: '🦁 *HONOURED ONE LOCKED.*' };
        you._taunted_until = (you._taunted_until || 0) + 30000;
        return { kind: 'taunt', note: `🦁 ${me.name} radiates an overwhelming aura! Enemy attack reduced.` };
    }
    return { kind: 'offense' };
}

// Validates and computes the result of a player's offensive PvP action without mutating
// HP. CE cost is reported (ceCost) so the caller can deduct it exactly once at resolution.
function pvpComputeOffense(me, you, user, command, args, match) {
    let dmg = 0, crit = false, defended = false, moveName = null, isDomain = false, fled = false, ceCost = 0;
    if (command === 'attack') {
         if (user.heavenly_restriction) {
             const stats = getCombatStats(user);
             dmg = Math.max(1, stats.attack + Math.floor(Math.random() * 12));
         } else {
            const variance = 0.9 + Math.random() * 0.25;
            dmg = Math.max(1, Math.round(me.atk * variance - you.def * 0.25));
            if (Math.random() < pvpCritChance(me, you)) { dmg = Math.floor(dmg * 1.5); crit = true; }
            if (user.loots?.includes('black_sparks') && Math.random() < 0.09) {
                dmg = Math.floor(dmg * 3);
                crit = true;
            }
        }
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
    } else if (command.startsWith('technique-')) {
        const n = command.split('-')[1];
        const key = user['technique_' + n];
        const move = user.skills && user.skills[key];
        if (!move) return { error: '*TECHNIQUE NOT FOUND.*' };
        const cost = Math.max(15, move.cost || 0);
        if (!user.heavenly_restriction && me.ce < cost) return { error: `[⚠️ INSUFFICIENT CE: NEEDS ${cost}, YOU HAVE ${Math.round(me.ce)}]` };
        if (!user.heavenly_restriction) ceCost = cost;
        const levelBonus = (user.level || 1) * 5;
        dmg = Math.max(1, Math.round((move.damage || 20) + me.atk * 0.4 - you.def * 0.25) + levelBonus);
        if (Math.random() < pvpCritChance(me, you)) { dmg = Math.floor(dmg * 1.5); crit = true; }
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
        moveName = move.name || key;
    } else if (command.startsWith('sk-')) {
        if (user.heavenly_restriction) return { error: '⛓️ *HEAVENLY RESTRICTION:* You cannot use skills. You wield quirks — use .qk-1 or .qk-2.' };
        const skillNum = parseInt(command.split('-')[1]);
        if (isNaN(skillNum) || skillNum < 1 || skillNum > 10) return { error: 'Usage: .sk-1 through .sk-10' };
        const skills = db.userSkills?.[user.player_id] || [];
        const skillId = skills[skillNum - 1];
        if (!skillId) return { error: `No skill in slot ${skillNum}.` };
        const skill = CROSS_UNIVERSE_SKILLS[skillId];
        if (!skill) return { error: 'Skill data missing.' };
        const cost = skill.ceCost || 0;
        if (!user.heavenly_restriction && me.ce < cost) return { error: `[⚠️ INSUFFICIENT CE: NEEDS ${cost}, YOU HAVE ${Math.round(me.ce)}]` };
        if (!user.heavenly_restriction) ceCost = cost;
        dmg = Math.max(1, skill.damage + Math.floor(Math.random() * 10));
        if (Math.random() < pvpCritChance(me, you)) { dmg = Math.floor(dmg * 1.5); crit = true; }
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
        moveName = skill.name;
        if (skill.effect === 'DODGE_NEXT' || skill.dodge_attack || skill.dodge_any || skill.invulnerable) {
            me.dodgeNext = true;
        }
    } else if (command === 'bu') {
        if (!user.loots?.includes('blood_manipulation')) return { error: '🩸 *BLOOD MANIPULATION REQUIRED.*' };
        const cost = 25;
        if (me.ce < cost) return { error: `[⚠️ INSUFFICIENT CE: .bu REQUIRES ${cost}]` };
        ceCost = cost;
        dmg = Math.max(1, Math.floor(me.atk * 1.8));
        if (Math.random() < pvpCritChance(me, you)) { dmg = Math.floor(dmg * 1.5); crit = true; }
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
        moveName = 'Piercing Blood';
    } else if (command === 'co') {
        if (!user.loots?.includes('comedian')) return { error: '🎭 *COMEDIAN REQUIRED.*' };
        if ((me._comedian_until || 0) > Date.now()) return { error: '🎭 *COMEDIAN BURNT OUT.*' };
        me._comedian_until = Date.now() + 60000;
        me._comedian_burnout_until = Date.now() + 30000;
        dmg = 0;
        moveName = 'Comedian';
    } else if (command === 'vow') {
        if (!user.loots?.includes('entropys_loom')) return { error: '🔮 *ENTROPY\'S LOOM REQUIRED.*' };
        you._vow_until = Date.now() + 120000;
        dmg = 0;
        moveName = 'Vow of Ruin';
    } else if (command === 'wa' || /^wa[1-6]$/.test(command)) {
        let weaponSlot = null;
        if (command !== 'wa') {
            const slotIdx = parseInt(command.slice(2)) - 1;
            const owned = user.weapons_owned || [];
            if (slotIdx < 0 || slotIdx >= owned.length) return { error: `🗡️ No weapon in slot ${slotIdx + 1}.` };
            weaponSlot = owned[slotIdx];
        }
        const activeWeapon = weaponSlot || user.weapon;
        if (!activeWeapon) return { error: '🗡️ *NO WEAPON EQUIPPED.* Buy one from .shops (it equips automatically on purchase).' };
        if (weaponSlot) user.weapon = weaponSlot;
        const wAtk = user.wa_attack || 6;
        dmg = Math.max(1, Math.round(wAtk * (0.9 + Math.random() * 0.25)));
        if (Math.random() < 0.1) { dmg = Math.floor(dmg * 1.5); crit = true; }
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
        moveName = activeWeapon.name;
    } else if (command.startsWith('qk-')) {
        const qkIdx = parseInt(command.split('-')[1]) - 1;
        const quirk = user.quirks?.[qkIdx];
        if (!quirk) return { error: `🌀 No quirk equipped in slot ${qkIdx + 1}.` };
        let qkDmg = Math.max(1, quirk.damage + Math.floor(Math.random() * 15));
        if (quirk.effect === 'multi_hit') {
            const hits = quirk.hits || 3;
            qkDmg = Math.max(1, Math.floor(qkDmg * hits * 0.6));
        } else if (quirk.effect === 'crit_guaranteed') {
            qkDmg = Math.floor(qkDmg * 1.5);
            crit = true;
        } else if (quirk.effect === 'armor_break') {
        } else if (quirk.effect === 'pierce') {
        } else if (quirk.effect === 'defend') {
            me.guarding = true;
        } else if (quirk.effect === 'pull_stun' || quirk.effect === 'stun') {
            you._pvpStunned = Math.max(you._pvpStunned || 0, quirk.stun || 1);
        } else if (quirk.effect === 'reflect_setup') {
            combat._reflectNext = true;
        }
        dmg = qkDmg;
        if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
        if (Math.random() < pvpCritChance(me, you)) { dmg = Math.floor(dmg * 1.5); crit = true; }
        moveName = quirk.name;
    } else if (command === 'cm') {
        if (!user.loots?.includes('copy_mimicry')) return { error: '👁️ *COPY (MIMICRY) REQUIRED.*' };
        const list = user._copied_techniques || [];
        if (!list.length) return { error: '📋 No techniques copied yet.' };
        const idx = parseInt(args[0]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= list.length) return { error: `📋 Invalid slot. Use .cm list to see your ${list.length} copied technique(s).` };
        const copied = list[idx];
        const casterPower = calcPower(user).attack;
        const baseHit = copied.damage || Math.max(14, Math.floor((copied.cost || 10) * 2));
        const levelBonus = (user.level || 1) * 5;
        dmg = Math.max(1, Math.floor(baseHit * 2.0 + casterPower * 1.1) + levelBonus);
        if (copied.double) dmg *= 2;
        if (copied.pierce || copied.unblockable || copied.structural) dmg = Math.floor(dmg * 1.15);
        if (Math.random() < 0.15) { dmg = Math.floor(dmg * 1.3); crit = true; }
        moveName = `COPY: ${copied.name || 'Mimicked Technique'}`;
    } else if (command === 'domain') {
        if (user.heavenly_restriction) return { error: '⛓️ *HEAVENLY RESTRICTION:* Domains cannot work on your body. You are immune to Domain Expansion.' };
        const limitless = user.loots && user.loots.includes('limitless_six_eyes') || !!getArmorEffect(user, 'six_eyes_vestments');
        if (!limitless && !(user.unlocked_features && user.unlocked_features.Domain) && !user.domain_unlocked) return { error: '🌌 *DOMAIN LOCKED.* Reach Grade 2 (or own LIMITLESS & SIX-EYES) and forge one with `.domain-n <name>` to expand a Domain.' };
        const cost = 80;
        if (me.ce < cost) return { error: `[⚠️ INSUFFICIENT CE: DOMAIN NEEDS ${cost}, YOU HAVE ${Math.round(me.ce)}]` };
        ceCost = cost;
        if (you.heavenly_restriction) {
            dmg = 0;
            moveName = 'Domain Expansion (blocked)';
            techEffects = [`⛓️ ${you.name}'s Heavenly Restriction body is immune to Domain Expansion!`];
            isDomain = true;
        } else {
            dmg = Math.max(1, Math.round(me.atk * 2 + 200 - you.def * 0.25));
            if (you.guarding) { dmg = Math.floor(dmg * 0.45); defended = true; }
            isDomain = true;
            moveName = limitless ? 'Infinite Void' : (user.domain_unlocked ? (user.domain_name || 'Domain Expansion') : 'Domain Expansion');
            // V2 Domain Mastery
            if (user.domain_mastery) {
                const masteryBonus = Math.min(user.domain_mastery * 0.03, 0.3);
                dmg = Math.floor(dmg * (1 + masteryBonus));
                if (user.domain_kills !== undefined) {
                    user.domain_kills = (user.domain_kills || 0) + 1;
                }
            }
        }
    } else if (command === 'csm-r') {
        if (!user.loots?.includes('cursed_spirit_manipulation')) return { error: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.*' };
        const army = user._cursed_army || [];
        if (!army.length) return { error: '🌀 No curses absorbed yet.' };
        dmg = 0;
        moveName = 'Maximum: Release';
        if (match) {
            match._cursed_army = [...army];
            match._cursed_army_hp = army.length * 100;
            match._cursed_army_owner = me.name;
        }
        user._cursed_army = [];
    } else if (command === 'flee') {
        fled = true;
    }
    return { dmg, crit, defended, moveName, isDomain, fled, ceCost };
}

// PvP turns are now committed per round: each fighter submits a move, then the whole
// round resolves at once. The fighter with the higher SPEED lands first.
async function handlePvpTurn(sock, from, sender, user, command, args) {
    const match = db.pvp[from];
    if (!match || !match.started) return false;
    if (match.turn !== sender) {
        await sock.sendMessage(from, { text: `⏳ *NOT YOUR TURN.* Waiting for ${pvpDisplayName(match.turn)} to act.`, mentions: [sender] });
        return true;
    }
    const opp = (sender === match.p1) ? match.p2 : match.p1;
    const me = match.players[sender];
    const meName = me.name;

    if (me._pvpStunned && me._pvpStunned > 0) {
        me._pvpStunned -= 1;
        match.committed[sender] = { command: 'stunned', args: [] };
        saveDb();
        await sock.sendMessage(from, { text: `😵 *${meName}* is stunned and cannot act this round!`, mentions: [sender] });
        if (match.committed[match.p1] && match.committed[match.p2]) {
            await resolvePvpRound(sock, from, match);
        } else {
            match.turn = opp;
        }
        return true;
    }

    // Passive CE regen on commit keeps the duel moving.
    me.ce = Math.min(me.maxce, me.ce + 15);

    match.committed = match.committed || {};
    if (match.committed[sender]) {
        await sock.sendMessage(from, { text: `✅ *YOU HAVE ALREADY ACTED THIS ROUND.* Waiting for ${pvpDisplayName(opp)}.`, mentions: [sender] });
        return true;
    }

    // Validate the action up front (no state mutation yet — resolution happens once both committed).
    const probe = pvpComputeOffense(me, match.players[opp], user, command, args, match);
    if (probe.error) { await sock.sendMessage(from, { text: probe.error, mentions: [sender] }); return true; }

    match.committed[sender] = { command, args };
    saveDb();

    if (match.committed[match.p1] && match.committed[match.p2]) {
        await resolvePvpRound(sock, from, match);
    } else {
        match.turn = opp;
        saveDb();
        await sock.sendMessage(from, { text: `⏳ *${meName} committed their move.* Now waiting for ${pvpDisplayName(opp)} to act — send your move!`, mentions: [opp] });
    }
    return true;
}

// Resolves a full PvP round once both fighters have committed a move.
// Defensive actions apply first (so guards are active), then attacks resolve in SPEED order.
async function resolvePvpRound(sock, from, match) {
    const p1 = match.p1, p2 = match.p2;
    const a = match.players[p1], b = match.players[p2];
    const aName = pvpDisplayName(p1), bName = pvpDisplayName(p2);
    const committed = match.committed;

    const faster = (a.spd >= b.spd) ? p1 : p2;
    const slower = (faster === p1) ? p2 : p1;
    const fasterName = (faster === p1) ? aName : bName;
    const fasterSpd = Math.round(match.players[faster].spd);

    // Phase 1 — defensive / self actions (rct heal, guard) applied first so guards are active.
    const selfNotes = [];
    for (const jid of [p1, p2]) {
        const me = match.players[jid];
        const you = (jid === p1) ? b : a;
        const r = pvpApplySelf(me, you, db.users[jid], committed[jid].command, committed[jid].args);
        if (r.note) selfNotes.push(r.note);
    }

    // Cursed army auto-attack (CSM release)
    if (match._cursed_army && match._cursed_army.length > 0) {
        const armyOwner = match._cursed_army_owner;
        const armyTarget = (armyOwner === aName) ? b : a;
        const armyDmg = Math.max(1, match._cursed_army.length * 60);
        armyTarget.hp = Math.max(0, armyTarget.hp - armyDmg);
        selfNotes.push(`🌀 Released curses strike ${armyTarget.name} for *${armyDmg}* damage!`);
    }

    // Phase 2 — offensive actions resolved in speed order (higher SPEED lands first).
    // Both fighters strike before the round's outcome is decided.
    const order = [faster, slower];
    const reports = [];
    for (const jid of order) {
        const me = match.players[jid];
        const you = (jid === p1) ? b : a;
        const c = committed[jid];
        const res = pvpComputeOffense(me, you, db.users[jid], c.command, c.args, match);
        if (res.ceCost) me.ce = Math.max(0, me.ce - res.ceCost);
        if (res.fled) {
            await resolvePvpWinner(sock, from, match, you, me, `${me.name} fled the duel — ${you.name} wins by forfeit`);
            return;
        }
        if (res.dmg > 0) {
            let dmg = res.dmg;
            if (you._taunted_until && you._taunted_until > Date.now()) dmg = Math.floor(dmg * 0.7);
            if (you._vow_until && you._vow_until > Date.now()) dmg = Math.floor(dmg * 1.2);
            if (me._comedian_until && me._comedian_until > Date.now()) dmg = 0;
            if (you.dodgeNext) { dmg = 0; you.dodgeNext = false; }
            if (match._cursed_army && match._cursed_army.length > 0 && match._cursed_army_owner === you.name) {
                const armyDmg = Math.min(dmg, (match._cursed_army_hp || match._cursed_army.length * 100));
                match._cursed_army_hp = (match._cursed_army_hp || match._cursed_army.length * 100) - armyDmg;
                if (match._cursed_army_hp <= 0) {
                    match._cursed_army = [];
                    match._cursed_army_hp = 0;
                    match._cursed_army_owner = null;
                    reports.push({ jid, res: { ...res, dmg: 0, cursedArmyDefeated: true }, you });
                    continue;
                }
                reports.push({ jid, res: { ...res, dmg: 0, cursedArmyHit: true, armyDmgRemaining: match._cursed_army_hp }, you });
                continue;
            }
            you.hp -= dmg;
            if (you.guarding) you.guarding = false;
            // V2 PvP mastery/stat tracking
            const pvpUser = db.users[jid];
            if (pvpUser && dmg > 0) {
                if (res.moveName && pvpUser.technique_mastery) {
                    const techId = c.command.replace('technique-', '').replace('sk-', '');
                    addTechniqueMasteryXp(pvpUser, techId, Math.ceil(dmg / 10));
                    recordTechniqueDamage(pvpUser, techId, dmg);
                    if (res.crit) recordCriticalHit(pvpUser);
                }
                if (c.command === 'wa' && pvpUser.weapon?.id) {
                    addWeaponMasteryXp(pvpUser, pvpUser.weapon.id, Math.ceil(dmg / 5));
                }
                if (!pvpUser.statistics) pvpUser.statistics = {};
                pvpUser.statistics.total_damage_dealt = (pvpUser.statistics.total_damage_dealt || 0) + dmg;
            }
        }
        reports.push({ jid, res, you });
    }

    // Decide the round only after BOTH fighters have acted. Higher SPEED lands first;
    // on a double-KO the faster fighter is the survivor.
    let winner = null, loser = null;
    const aDead = a.hp <= 0, bDead = b.hp <= 0;
    if (aDead && bDead) { winner = faster; loser = slower; }
    else if (aDead) { winner = p2; loser = p1; }
    else if (bDead) { winner = p1; loser = p2; }

    match.committed = {};
    match.round++;

    function atkLine(report) {
        const me = match.players[report.jid];
        const you = report.you;
        const res = report.res;
        if (res.dmg > 0) {
            const tag = res.isDomain ? '🌌' : (res.moveName ? '✨' : '⚔️');
            const move = res.moveName ? ` *${res.moveName}*` : '';
            return `${tag} ${me.name} unleashed${move} for *${res.dmg}*${res.crit ? ' (CRITICAL!)' : ''}${res.defended ? ' — guarded −55%' : ''} (${you.name}: ${Math.max(0, Math.round(you.hp))}/${you.maxhp} HP)`;
        }
        return null;
    }

    let msg = `╔══════════════════════════════════════╗\n   𝔎𝔈ℕℕ𝔜𝔍𝔄𝔎𝔖 : 𝔓𝔙ℙ 𝔇𝔘𝔈𝔏 — ROUND ${match.round - 1} RESOLUTION\n╚══════════════════════════════════════╝\n`;
    msg += `⚡ *${fasterName}* (SPD ${fasterSpd}) moves FIRST — highest speed!\n`;
    msg += `──────────────────────────────────────────\n`;
    const ordered = reports.slice().sort((x, y) => order.indexOf(x.jid) - order.indexOf(y.jid));
    for (const r of ordered) {
        const line = atkLine(r);
        if (line) msg += line + '\n';
    }
    for (const n of selfNotes) msg += n + '\n';
    msg += `──────────────────────────────────────────\n`;

    if (winner) {
        await sock.sendMessage(from, { text: msg, mentions: [p1, p2] });
        await resolvePvpWinner(sock, from, match, winner, loser, `${pvpDisplayName(winner)} overwhelmed ${pvpDisplayName(loser)} (${Math.max(0, Math.round(match.players[loser].hp))} HP left)`);
        return;
    }

    match.turn = p1;
    saveDb();
    await sock.sendMessage(from, { text: msg, mentions: [p1, p2] });
    await sendPvpStatus(sock, from, match, `▶️ *ROUND ${match.round}* — both fighters, send your move!`);
}

function combatDamageMult(combat) {
    let m = 1;
    for (const s of (combat.playerStatus || [])) {
        if (s.type === 'WEAKEN') m *= (1 - (s.value || 0));
        if (s.type === 'BLIND') m *= 0.85;
    }
    return m;
}

function combatStatusSummary(combat) {
    const statuses = (combat.playerStatus || []).length ? combat.playerStatus.map(s => `${s.name}(${s.turns})`).join(' ') : '';
    const ecological = combat.ecologicalEvent ? `\n⚠️ ${combat.ecologicalEvent.name}` : '';
    const distance = combat.darkRegion ? `\n📏 Distance: ${combat.distance || 5}m` : '';
    return statuses + ecological + distance;
}

// Resolves the enemy's telegraphed intent. Returns damage/status info WITHOUT applying HP.
function resolveEnemyAction(combat, user, weaken = 1) {
    const enemy = combat.enemy;
    const move = combat.enemyIntent || ENEMY_MOVE_POOL[0];
    const baseAtk = Math.max(1, enemy.atk || calcPower(enemy).attack);
    // Player defense softly mitigates incoming hits (capped at 50% so it can't trivialize fights).
    const defMit = 100 / (100 + Math.min(getCombatStats(user).defense, 300));
    let eDamage = 0;
    let statusApplied = null;
    let guarded = false;
    let enemyDesc;
    if (combat.enemyStunned && combat.enemyStunned > 0) {
        combat.enemyStunned -= 1;
        combat.enemyGuarding = false;
        return { move: { kind: 'stunned', label: 'Incapacitated' }, eDamage: 0, enemyDesc: `${enemy.name} is reeling from your technique and cannot act!`, statusApplied: null, guarded: false, stunned: true };
    }
    // DOMAIN CLASH burnout: the losing curse can only lash out with basic strikes for 2 rounds.
    if ((combat.enemyDomainBurnout || 0) > 0) {
        combat.enemyDomainBurnout--;
        combat.enemyGuarding = false;
        let mult = move.mult || 1;
        let dmg = Math.floor(baseAtk * mult * weaken * defMit);
        if (combat.guarding) { dmg = Math.floor(dmg * 0.4); combat.guarding = false; guarded = true; }
        if (combat.dodgeNext) { dmg = 0; combat.dodgeNext = false; }
        if (Math.random() < 0.16) dmg = 0;
        return { move, eDamage: dmg, enemyDesc: `${enemy.name} is scorched by CE burnout — it can only manage a basic strike.`, statusApplied: null, guarded };
    }
    // Curses can unleash a Domain Expansion at random (chance scales per-enemy).
    if (Math.random() < (enemy.domainChance ?? (enemy.canDomain ? 0.12 : 0))) {
        combat.enemyGuarding = false;
        const domainName = getEnemyDomainName(enemy);
        if (user.heavenly_restriction) {
            return { move: { kind: 'domain', label: 'Domain Expansion' }, eDamage: 0, enemyDesc: `${enemy.name} expands its Domain — *${domainName}*! But it has no effect on you. Your Heavenly Restriction body is immune.`, statusApplied: null, guarded: false, domain: true, domainName };
        }
        let eDamage = Math.floor(baseAtk * 3.2 * weaken); // sure-hit: ignores guard and dodge
        const tojiWard = getArmorEffect(user, 'toji_ward');
        if (tojiWard) { eDamage = 0; enemyDesc = `🛡️ Toji's Heavenly Restriction Ward negates the domain's guaranteed-hit!`; }
        else {
            combat.guarding = false;
            combat.dodgeNext = false;
            applyCombatStatus(combat, { type: 'WEAKEN', name: 'Domain Pressure', value: 0.2, turns: 2 });
            statusApplied = 'Domain Pressure';
            enemyDesc = `🌌 ${enemy.name} expands its Domain — *${domainName}*! An inescapable sure-hit engulfs you.`;
        }
        // DADDYRAGA: a repeated attack is fully adapted away.
        if (user.loots?.includes('daddyraga') && eDamage > 0) {
            combat._daddyHits = combat._daddyHits || {};
            const sig = 'domain:' + domainName;
            if (combat._daddyHits[sig]) { eDamage = 0; enemyDesc += ' DADDYRAGA adapts — the domain is rendered harmless!'; }
            else combat._daddyHits[sig] = true;
        }
        return { move: { kind: 'domain', label: 'Domain Expansion' }, eDamage, enemyDesc: enemyDesc || 'Domain Expansion blocked.', statusApplied, guarded: false, domain: true, domainName };
    }
    if (move.kind === 'defend') {
        // ENTROPY'S LOOM — Vow of Ruin nullifies all enemy defense skills during its window.
        if (user.loots?.includes('entropys_loom') && Date.now() < (user._vow_until || 0)) {
            enemyDesc = `${enemy.name} attempts to brace, but ENTROPY'S LOOM unravels its guard — defense fails!`;
        } else {
            combat.enemyGuarding = true;
            enemyDesc = `${enemy.name} raises a Cursed Guard, bracing against your next strike.`;
        }
    } else {
        combat.enemyGuarding = false;
        let mult = move.mult || 1;
        eDamage = Math.floor(baseAtk * mult * weaken * defMit);
        
        // Environmental modifiers
        if (combat.darkRegion) {
            const region = db.darkContinent?.regions?.[combat.regionId];
            if (region?.environmental) {
                const env = region.environmental;
                // Gravity Inversion: melee attacks miss
                if (env.effect === 'gravity' && move.kind === 'basic') {
                    eDamage = 0;
                    enemyDesc = `🌌 GRAVITY INVERSION! ${enemy.name}'s melee attack fails — they float away!`;
                }
                // Blood Moon: damage increase
                if (env.effect === 'berserk') {
                    eDamage = Math.floor(eDamage * (env.damageMult || 1.3));
                }
                // Static Field: stun chance
                if (env.effect === 'stun_chance' && eDamage > 0 && Math.random() < (env.stunChance || 0.3)) {
                    applyCombatStatus(combat, { type: 'STUN', name: 'Static Stun', turns: 1 });
                    statusApplied = 'Static Stun';
                }
            }
        }
        
        // Ecological Chaos modifiers
        if (combat.darkRegion && combat.ecologicalEvent && eDamage > 0) {
            const event = combat.ecologicalEvent;
            if (event.effect === 'gravity' && move.kind === 'basic') {
                eDamage = 0;
                enemyDesc = `🌌 ECOLOGICAL CHAOS: Gravity Inversion! ${enemy.name}'s melee attack fails!`;
            }
            if (event.effect === 'resonance') {
                eDamage = Math.floor(eDamage * (event.damageMult || 1.25));
                enemyDesc = (enemyDesc || '') + ` 🔊 RESONANCE: Damage amplified!`;
            }
        }
        
        if (combat.guarding) { eDamage = Math.floor(eDamage * 0.4); combat.guarding = false; guarded = true; }
        if (combat.dodgeNext) { eDamage = 0; combat.dodgeNext = false; }
        if (Math.random() < 0.16) eDamage = 0;
        if (eDamage > 0 && move.status) { applyCombatStatus(combat, move.status); statusApplied = move.status.name; }
        enemyDesc = getCinematicEnemyDescription(enemy.name, {}, eDamage);
        // DADDYRAGA: any attack used more than once is adapted away.
        if (user.loots?.includes('daddyraga')) {
            combat._daddyHits = combat._daddyHits || {};
            const sig = (move.kind || 'x') + ':' + (move.label || '');
            if (combat._daddyHits[sig]) { eDamage = 0; enemyDesc = `${enemy.name}'s ${move.label || 'strike'} is adapted away by DADDYRAGA!`; }
            else combat._daddyHits[sig] = true;
        }
    }
    // LIMITLESS & SIX-EYES: Infinity passive — enemies (except HR users) cannot approach/hit the user.
    if (user.loots?.includes('limitless_six_eyes') && !enemy.heavenly_restriction) {
        eDamage = 0;
        enemyDesc = `${enemy.name} cannot approach — Infinity repels all attempts to make contact!`;
    }
    // JUDGMEN WEAKEN: enemy attacks do only 5 damage for 3 rounds after .jd
    if (combat._judgeman_weak && eDamage > 0) {
        eDamage = 5;
        enemyDesc = (enemyDesc || '') + ' ⚖️ (Judgeman seal: attacks weakened to 5 damage!)';
        combat._judgeman_rounds = (combat._judgeman_rounds || 0) - 1;
        if (combat._judgeman_rounds <= 0) {
            combat._judgeman_weak = false;
            if (combat._enemy_original_skills) enemy.skills = combat._enemy_original_skills;
            if (combat._enemy_original_technique) enemy.technique = combat._enemy_original_technique;
            combat._enemy_original_skills = null;
            combat._enemy_original_technique = null;
        }
    }
    return { move, eDamage, enemyDesc, statusApplied, guarded };
}

function runEnemyPhase(combat, user, weaken = 1) {
    const res = resolveEnemyAction(combat, user, weaken);
    if (combat._reflectNext && res.eDamage > 0 && res.move?.kind !== 'basic') {
        const reflected = Math.floor(res.eDamage * 0.8);
        res.eDamage = 0;
        if (combat.enemy?.stats?.HP > 0) combat.enemy.stats.HP -= reflected;
        res.enemyDesc = (res.enemyDesc || '') + ` 🪞 REBOUND BARRIER! ${reflected} damage reflected back!`;
        combat._reflectNext = false;
    }
    // JACKPOT: 6 minutes of infinite HP/CE after .jk — incoming damage is nullified.
    if (user.loots?.includes('jackpot') && Date.now() < (user._jackpot_until || 0)) {
        res.eDamage = 0;
        user.stats.HP = user.stats.Max_HP;
        user.stats.CE = user.stats.Max_CE;
    }
    // DADDYRAGA: only a one-shot (a single hit >= current HP) can kill — chip damage is ignored.
    if (user.loots?.includes('daddyraga') && res.eDamage > 0 && res.eDamage < user.stats.HP) {
        res.eDamage = 0;
    }
    // COMEDIAN: while active, any attack used on the user fails to connect (absolute reality).
    if (user.loots?.includes('comedian') && Date.now() < (user._comedian_until || 0)) {
        res.eDamage = 0;
    }
    // ARMOR: Shaman's Ritual Robes — halve incoming curse damage.
    const curseDmgReduction = getArmorEffect(user, 'curse_damage_reduction');
    if (curseDmgReduction && (combat.enemy.grade === 0 || combat.enemy.name?.toLowerCase().includes('curse'))) {
        res.eDamage = Math.floor(res.eDamage * (1 - curseDmgReduction));
    }
    // ARMOR: Shroud of the Four-Armed Calamity — -75% all incoming damage.
    const shroudReduction = getArmorEffect(user, 'sukuna_shroud');
    if (shroudReduction && res.eDamage > 0) {
        res.eDamage = Math.floor(res.eDamage * 0.25);
    }
    // ARMOR: Void Vestments of the Six Eyes — immune to basic physical/projectile attacks.
    const sixEyesImmune = getArmorEffect(user, 'six_eyes_vestments');
    if (sixEyesImmune && res.move?.kind === 'basic') {
        res.eDamage = 0;
    }
    // ARMOR: Shroud of the Four-Armed Calamity — counter-slash below 30% HP.
    if (shroudReduction && (user.stats.HP || 0) < (user.stats.Max_HP || 1) * 0.3 && res.eDamage > 0 && !user._shroud_counter_used) {
        user._shroud_counter_used = true;
        res.eDamage = Math.floor(res.eDamage * 0.1);
        res.enemyDesc = (res.enemyDesc || '') + ' 🩸 Shroud counter-slash!';
    }
    // ARMOR: flat defense from equipped armor directly reduces incoming physical damage.
    const armorDef = (user.equipment?.armor?.stats?.defense || 0);
    if (armorDef > 0 && res.eDamage > 0) {
        res.eDamage = Math.max(0, res.eDamage - Math.floor(armorDef * 0.3));
    }
    if (res.eDamage > 0) {
        user.stats.HP -= res.eDamage;
        
        // Stance break on high physical damage
        if (res.move?.kind === 'basic' || res.move?.kind === 'attack') {
            applyStanceDamage(user, Math.floor(res.eDamage * 0.5));
        }
    }
    return { ...res, dead: user.stats.HP <= 0 };
}

// Co-op battles: a combat is keyed by the host's jid, but every participant (host + allies)
// gets their own key pointing at the SAME combat object, so all the existing single-player
// handlers (which read db.combats[sender]) keep working unchanged for any participant.
 function endCombatKeys(combat) {
     const parts = combat.participants || [];
     for (const j of parts) {
         if (db.combats[j] === combat) delete db.combats[j];
         const u = db.users[j];
         if (u) { u._temp_speed_buff = undefined; u._dharma_stacks = 0; }
     }
     for (const [j, c] of Object.entries(db.combats)) { if (c === combat) delete db.combats[j]; }
 }

function updateDarkRegionLogbook(combat, user, outcome) {
    if (!combat.darkRegion) return;
    const region = db.darkContinent?.regions[combat.regionId];
    if (!region) return;
    const time = new Date().toLocaleTimeString();
    const name = user.name || 'Unknown';
    if (outcome === 'victory') {
        region.logbook.push(`${time} — ${name} fought ${combat.enemy.name} and won.`);
        if (combat.skillsFound && combat.skillsFound.length) {
            combat.skillsFound.forEach(sid => {
                const s = CROSS_UNIVERSE_SKILLS[sid];
                if (s) region.logbook.push(`${time} — ${name} discovered skill: ${s.name}.`);
            });
        }
    } else if (outcome === 'defeat') {
        region.logbook.push(`${time} — ${name} fought ${combat.enemy.name} and was defeated.`);
    } else if (outcome === 'fled') {
        region.logbook.push(`${time} — ${name} fled from ${combat.enemy.name}.`);
    }
    if (region.logbook.length > 50) region.logbook = region.logbook.slice(-50);
}

// Resolve a participant's death. Host death ends the whole battle; an ally is simply
// knocked out and removed, leaving the rest of the co-op fight intact.
 async function resolveCombatDeath(sock, from, sender, combat, actorJid, actorUser) {
     // ARMOR: Garb of the Thousand-Year Mastermind — instant revive on fatal damage.
     const mastermindCooldown = actorUser._mastermind_revive_until || 0;
     if (Date.now() > mastermindCooldown) {
         const mastermindEffect = getArmorEffect(actorUser, 'mastermind_garb');
         if (mastermindEffect && (actorUser.wallet || 0) >= Math.floor((actorUser.wallet || 0) * 0.5)) {
             const cost = Math.floor((actorUser.wallet || 0) * 0.5);
             actorUser.wallet -= cost;
             actorUser.stats.HP = actorUser.stats.Max_HP;
             actorUser.stats.CE = actorUser.stats.Max_CE;
             actorUser._mastermind_revive_until = Date.now() + 60 * 60 * 1000;
             saveDb();
             await sock.sendMessage(from, { text: `🧠 *MASTERMIND GARB ACTIVATED!*\nThe armor consumes 50% of your K-Coins (${fmtNum(cost)}) and revives you at 100% HP and CE!\nAll skill cooldowns reset.\nCooldown: 1 hour.`, mentions: [actorJid] });
             return 'revived';
         }
     }
      if (actorJid === combat.host) {
          const result = processDefeat(actorUser, 'standard');
          // Culling Game elimination: if the player dies, they're out
          if (db.cullingGame?.active && db.cullingGame.players[actorJid]) {
              delete db.cullingGame.players[actorJid];
              actorUser.cullingGame.points = 0;
              try { await sock.sendMessage(actorJid, { text: `💀 *CULLING GAME — ELIMINATED*\nYou were knocked out of the Culling Game!\nYou have been removed from the barrier.`, mentions: [actorJid] }); } catch {}
          }
          endCombatKeys(combat);
          saveDb();
          await sock.sendMessage(from, { text: result, mentions: [actorJid] });
          return 'ended';
      }
      combat.participants = (combat.participants || []).filter(j => j !== actorJid);
      if (db.combats[actorJid] === combat) delete db.combats[actorJid];
      const result = processDefeat(actorUser, 'standard');
      // Culling Game elimination: if the player dies, they're out
      if (db.cullingGame?.active && db.cullingGame.players[actorJid]) {
          delete db.cullingGame.players[actorJid];
          actorUser.cullingGame.points = 0;
          try { await sock.sendMessage(actorJid, { text: `💀 *CULLING GAME — ELIMINATED*\nYou were knocked out of the Culling Game!\nYou have been removed from the barrier.`, mentions: [actorJid] }); } catch {}
      }
      saveDb();
      await sock.sendMessage(from, { text: `💀 ${actorUser.name || actorJid} was knocked out of the co-op battle!\n${result}`, mentions: [actorJid] });
      return 'knocked';
  }

// ── Sukuna Raid: 20 fingers hidden in curses → the strongest curse awakens ──
// Sukuna is the strongest Special Grade in history: colossal HP, Malevolent Shrine domain.
const SUKUNA = { name: 'Ryomen Sukuna', grade: 0, maxHp: 650000, atk: 1500, domainDmg: 3400, domainName: 'Malevolent Shrine' };
const FINGER_DROP_CHANCE = 1.0;   // guaranteed once a curse's finger is still available
const MAX_RAID_PLAYERS = 30;

// ── Global trivia quests ──
// Hard Jujutsu Kaisen questions. The first user to answer correctly across all GCs
// wins 4000 XP and 5,000,000 Gold. Answers are matched normalized (lowercase, no punctuation).
function normalizeAnswer(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Bound summons scale with their owner's grade: higher grade = far stronger familiar.
// Grade 0 (Special) is the apex; each lower grade step is a fraction of that power.
const SUMMON_GRADE_MULT = [8, 5, 3, 1.8, 1]; // index by grade: 0=Special, 1, 2, 3, 4
function getSummonCost(pl) {
    return Math.floor(pl * 15) + 100000;
}
function summonBattleStats(owned, grade, user) {
    const stats = user ? getCombatStats(user) : null;
    const userAtk = stats ? stats.attack : 100;
    const atk = Math.max(5, Math.floor(userAtk * 0.35));
    return { atk, hp: atk * 5 };
}

// Grade helpers for the .give-gr mod command. Grade 0 = Special, 1..4 = Grade 1..4.
const GRADE_NAMES = ['Special Grade', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4'];
function parseGradeArg(a) {
    if (a == null) return null;
    const s = String(a).toLowerCase().trim();
    if (s.includes('special')) return 0;
    const n = parseInt(s, 10);
    if (!isNaN(n) && n >= 0 && n <= 4) return n;
    return null;
}
function gradeBandStart(g) { return [150, 70, 30, 10, 1][g]; } // level at which a grade band begins

const QUEST_POOL = [
    { q: 'WHAT IS THE NAME OF GOJO SATORU’S DOMAIN EXPANSION?', a: 'Infinite Void' },
    { q: 'WHAT IS THE NAME OF RYOMEN SUKUNA’S DOMAIN EXPANSION?', a: 'Malevolent Shrine' },
    { q: 'HOW MANY FINGERS OF RYOMEN SUKUNA EXIST IN TOTAL? (NUMBER ONLY)', a: '20' },
    { q: 'WHAT IS THE FULL NAME OF TOKYO JUJUTSU HIGH’S PRINCIPAL?', a: 'Yaga Masamichi' },
    { q: 'WHAT IS THE NAME OF YUTA OKKOTSU’S CURSED SPIRIT PARTNER?', a: 'Rika' },
    { q: 'WHICH CURSED SPIRIT POSSESSED JUNPEI YOSHINO?', a: 'Mahito' },
    { q: 'WHAT IS THE NAME OF THE TECHNIQUE THAT LETS THE USER MOVE AT 24 FRAMES PER SECOND?', a: 'Projection Sorcery' },
    { q: 'WHAT GRADE OF SORCERER IS YUTA OKKOTSU CLASSIFIED AS?', a: 'Special Grade' },
    { q: 'WHAT IS THE NAME OF THE TEN SHADOWS TECHNIQUE’S STRONGEST SHIKIGAMI?', a: 'Mahoraga' },
    { q: 'WHO IS THE CURSED SPIRIT RESPONSIBLE FOR CREATING THE CULLING GAME?', a: 'Kenjaku' },
    { q: 'WHAT IS THE FIRST NAME OF THE STRONGEST SORCERER, GOJO?', a: 'Satoru' },
    { q: 'WHAT IS THE NAME OF YUJI ITADORI’S GRANDFATHER?', a: 'Wasuke' },
    { q: 'HOW MANY SHIKIGAMI DOES THE TEN SHADOWS TECHNIQUE SUMMON AT FULL POTENTIAL? (NUMBER ONLY)', a: '10' },
    { q: 'WHAT IS THE NAME OF THE TECHNIQUE THAT REVERSES CURSED ENERGY TO HEAL WOUNDS?', a: 'Reverse Cursed Technique' },
    { q: 'WHAT IS THE NAME OF THE ZENIN CLAN’S TECHNIQUE THAT MANIPULATES BLOOD?', a: 'Blood Manipulation' }
];

// ── Summon Shop: one-of-a-kind familiars (each can only be claimed once, globally) ──
 const SUMMON_SHOP = [
     { id: 1, name: 'Rabbit Escape', tier: 'Mid-Tier Specialization', pl: 18500, move: 'Swarm Distraction', effect: 'Blinds the enemy target, lowering their attack accuracy by 40% for the next turn phase.' },
     { id: 2, name: 'The Piercing Ox', tier: 'Mid-Tier Specialization', pl: 39000, move: 'Linear Momentum Charge', effect: 'The longer the fight lasts, the more damage this move scales. Increases base physical output by +10% every active turn.' },
     { id: 3, name: 'Iron-Shell Genbu', tier: 'Mid-Tier Specialization', pl: 35000, move: 'Cursed Bastion Wall', effect: 'Places a protective barrier over the team. Completely absorbs the next incoming physical .attack string.' },
     { id: 4, name: 'Tiger Funeral', tier: 'Elite Tier: Master Class', pl: 58000, move: 'Claw of the Mourning Beast', effect: 'Heavy slashing offensive that inflicts a bleeding status, draining 5% of the enemy’s total HP pool every turn for 3 turns.' },
     { id: 5, name: 'Mourning Tiger', tier: 'Elite Tier: Master Class', pl: 64000, move: 'Roar of Lamentation', effect: 'Emits a shockwave that shatters low-tier barriers and drains 40 units of active target Cursed Energy.' },
     { id: 6, name: 'Phase Shadow: Kage-Gami', tier: 'Elite Tier: Master Class', pl: 71000, move: 'Umbral Shift', effect: 'Grants the player a 30% passive evasion rate boost. When successfully dodging, automatically counters with a shadow strike.' },
     { id: 7, name: 'Void Serpent: Leviathan Core', tier: 'Apex Tier: Mythological Calamities', pl: 105000, move: 'Event Horizon Constriction', effect: 'Traps the hostile target inside a gravity fold, disabling their ability to use .domain expansion or active defensive stances for 3 complete turn blocks.' },
     { id: 8, name: 'Crimson Emperor: Suzaku', tier: 'Apex Tier: Mythological Calamities', pl: 92000, move: 'Cursed Inferno Rebirth', effect: 'Deals massive, un-blockable fire technique output damage. If the player sustains fatal damage while Suzaku is active, revives the player once per combat with 25% base HP.' },
     { id: 9, name: 'Divine Dog: White / Black', tier: 'Lower Tier: Fledgling', pl: 4500, move: "Hunter's Tracking / Kinetic Claw", effect: 'Lowers opponent evasion by 15% and inflicts a base physical strike.' },
     { id: 10, name: 'The Owls: Toad Amalgam', tier: 'Lower Tier: Fledgling', pl: 8200, move: 'Tongue Entanglement', effect: 'Restricts target physical movements, forcing them to skip 1 retribution phase turn.' },
     { id: 11, name: 'Nue', tier: 'Mid Tier: Grade Specialization', pl: 24000, move: 'Thunderclap dive', effect: 'Striking with electrical CE that deals 1.5x damage during [RAIN_STORM] hazards and applies a 2-turn [Paralysis] status.' },
     { id: 12, name: 'Great Serpent (Orochi)', tier: 'Mid Tier: Grade Specialization', pl: 36500, move: 'Ground Burst Rupture', effect: 'Heavy armor-piercing damage string that ignores 20% of the target curse’s defensive stats.' },
     { id: 13, name: 'Max Elephant', tier: 'Mid Tier: Grade Specialization', pl: 42000, move: 'Pressure Torrent', effect: 'Flushes the battlefield. Drains 30% of target CE and increases the summoner’s own technique accuracy keys by 25%.' },
     { id: 14, name: 'Eight-Handled Sword Divergent Sila Divine General Mahoraga', tier: 'Apex Tier: Mythological Calamities', pl: 120000, move: 'Sword of Extermination / Dharma Wheel Adaptation', effect: 'If Mahoraga takes the same technique damage twice, he becomes 100% immune to it for the rest of the battle loop. His active strikes deal complete bypass absolute damage to Cursed Spirits.' },
     { id: 15, name: 'Agito the Merged Beast', tier: 'Apex Tier: Mythological Calamities', pl: 85000, move: 'Tranquil Deer Regeneration Burst', effect: 'Automatically casts an active healing pulse every turn, restoring 15% of the player’s max HP while maintaining a high offensive output speed.' },
     { id: 16, name: 'Heavenly Retribution: Asura of the Ash-fields', tier: 'God-Tier: Mythological Calamities', pl: 145000, move: 'Sovereign Carnage / Final Unbinding', effect: 'The ultimate high-stakes summon. Asura begins the fight with 1 HP but gains an additional +100% Damage Output and Evasion for every 10% HP the summoner is currently missing. If the summoner dies, Asura absorbs their soul to fight on independently for 3 additional turns with 200% stats.' },
     { id: 17, name: 'The Void Sovereign: Ouroboros', tier: 'God-Tier: Mythological Calamities', pl: 135000, move: 'Infinity Devour / Entropy Loop', effect: 'Passive consumption engine. Whenever Ouroboros takes damage, it converts 100% of the kinetic impact directly into Cursed Energy for the summoner, continuously fueling ultimate attacks while rendering standard attacks counterproductive.' },
     { id: 18, name: 'Nine-Tailed Harbinger: Tamamo-no-Mae', tier: 'God-Tier: Mythological Calamities', pl: 125000, move: 'Hex of the Mirror Soul', effect: 'Every time the opponent attacks, Tamamo duplicates the attack logic, dealing the exact same raw damage and status effects back to the attacker in real-time, effectively punishing high-damage glass cannon builds.' },
     { id: 19, name: 'The Abyssal Keeper: Leviathan’s Jaw', tier: 'God-Tier: Mythological Calamities', pl: 130000, move: 'Tidal Lock Gravity', effect: 'Pulls the entire battlefield into a temporal slow-state. Permanently reduces the enemy’s attack speed/turn priority to absolute zero, forcing them to take 2 turns of damage for every 1 action they manage to register.' },
     { id: 20, name: '💍 Rika (The Queen of Curses)', tier: 'God-Tier: Apex Catastrophe', pl: 135000, move: 'Cursed Energy Beam / Infinite Replenishment', effect: 'Special Grade Vengeful Cursed Spirit / Shikigami. When summoned, grants the user infinite CE replenishment for 5 minutes (Rika mode), acts as external cursed-tool storage, and executes massive raw physical or energy beam attacks. Use .su to manifest her.' }
];

// ── Weapon Shop (Cursed Tools) ──
// One weapon per user. Base weapon strike (.wa) deals 6 damage; a fighter who awakens
// HEAVENLY RESTRICTION sees their .wa climb to 200 and their .attack to 150.
const WEAPON_SHOP = [
    { id: 1, name: 'Inverted Spear of Heaven', potency: 'Special Grade', effect: 'Forced Technique Nullification', desc: "A dagger with a distinct double-pronged blade. It forcefully bypasses and completely shuts down any active cursed technique it comes into physical contact with.", cost: 600000 },
    { id: 2, name: 'Playful Cloud', potency: 'Special Grade', effect: 'Pure Kinetic Power Scaling', desc: "The only Special Grade tool without an imbued cursed technique. Its power scales directly and infinitely with the pure physical strength and muscle density of its wielder.", cost: 580000 },
    { id: 3, name: 'Split Soul Katana', potency: 'Special Grade', effect: 'Direct Soul Laceration', desc: "A blade that completely ignores the physical toughness and external armor of any target, cutting directly through the boundaries of the victim's soul. Requires advanced perception to use at 100% capacity.", cost: 620000 },
    { id: 4, name: 'Black Rope', potency: 'Special Grade', effect: 'Cursed Energy Disruption', desc: "Woven over decades by sorcerers in Africa. When struck against an opponent, it disrupts and unravels the effects of active innate techniques, though the rope burns away as it is used.", cost: 590000 },
    { id: 5, name: "Nanami's Blunt Sword", potency: 'Grade 1 (Custom Imbued)', effect: '7:3 Ratio Point Detonation', desc: "A blunt, wrapped cleaver calibrated to work with the Ratio Technique. It creates a structural weak point on the target, triggering critical impact damage on physical strikes.", cost: 450000 },
    { id: 6, name: 'Dragon Bone', potency: 'Grade 1', effect: 'Kinetic Storage & Jet Propulsion', desc: "A specialized sword crafted by Juzo Kumiya. It absorbs the impact force and kinetic energy of incoming attacks, storing it to unleash as an explosive propulsion burst.", cost: 470000 },
    { id: 7, name: 'Slaughter Demon', potency: 'Grade 4 / 3', effect: 'Basic Cursed Infusion', desc: "A reliable tactical combat knife standard-issued to beginners. It holds a stable baseline of cursed energy, allowing trainees without active techniques to harm low-level curses.", cost: 400000 },
    { id: 8, name: 'Prison Realm', potency: 'Legendary / Special Grade', effect: 'Seals Target for 24 Hours', desc: 'A legendary cursed tool capable of sealing a target away for 24 hours. The sealed target cannot use any commands or techniques. Only Playful Cloud, Black Rope, or Limitless can break the seal.', cost: 10000000000 }
];

// Releases a summon back to the shop so it can be claimed again by anyone.
function releaseSummonToShop(user, id) {
    user.ownedSummons = (user.ownedSummons || []).filter(s => s !== id);
    if (db.soldSummons && db.soldSummons[id] === (user.player_id || user)) delete db.soldSummons[id];
}

// Enforces the one-summon rule: a user may only ever hold a single familiar.
// Releases every summon the user currently owns back to the shop and binds only `keepId`.
function setSingleSummon(user, keepId, item) {
    db.soldSummons = db.soldSummons || {};
    for (const oid of (user.ownedSummons || [])) {
        if (oid !== keepId && db.soldSummons[oid] === (user.player_id || user)) delete db.soldSummons[oid];
    }
    const stats = getCombatStats(user);
    const atk = Math.max(5, Math.floor(stats.attack * 0.35));
    const hp = atk * 5;
    user.summon = { active: true, name: item.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: item.move, effect: item.effect, pl: item.pl };
    user.ownedSummons = [keepId];
    db.soldSummons[keepId] = user.player_id || user;
}

function grantHeavenlyRestriction(user) {
    if (user.heavenly_restriction) return false;
    user.heavenly_restriction = true;
    user._bonus_attack = (user._bonus_attack || 0) + 200;
    user._bonus_defense = (user._bonus_defense || 0) + 200;
    user.wa_attack = 200;
    user.stats.Max_CE = 0;
    user.stats.CE = 0;
    user.innate_technique_id = 'Heavenly Restriction';
    user.skills = INNATE_TECHNIQUES['Heavenly Restriction']?.moves || {};
    user.technique_1 = 'heavy_slash';
    user.technique_2 = 'clap_smash';
    user.technique_3 = 'super_fast_slash';
    user.technique_4 = 'divine_axe_slash';
    user.technique_5 = 'ricochet_throw';
    user.technique_6 = 'parry_counter';
    user.custom_technique = null;
    user.unlocked_features = { RCT: false, Domain: false, Simple_Domain: false };
    user.loots = [];
    user.quirks = pickRandomQuirks(2);
    if (db.userSkills && db.userSkills[user.player_id]) {
        db.userSkills[user.player_id] = [];
    }
    if (user.ownedSummons && user.ownedSummons.length) {
        for (const sid of user.ownedSummons) releaseSummonToShop(user, sid);
        user.ownedSummons = [];
        user.summon = { active: false, name: 'None', HP: 0, Max_HP: 0, CE: 0, Max_CE: 0, atk: 0, move: null, effect: null, pl: 0 };
    }
    return true;
}

function getImageFromMessage(msg) {
    if (!msg) return null;
    const img = msg.message?.imageMessage;
    const stk = msg.message?.stickerMessage;
    if (img) return { type: 'image', message: msg };
    if (stk) return { type: 'sticker', message: msg };
    return null;
}

function fmtStat(val, isCE = false) {
    if (isCE && val === Infinity) return '∞';
    if (val === Infinity) return '∞';
    return String(val);
}

 function ceFor(user) {
     if (user.loots?.includes('limitless_six_eyes')) return '∞';
     if (user.heavenly_restriction) return 'N/A';
     return `${user.stats.CE}/${user.stats.Max_CE}`;
 }

function ensureFingerState() {
    if (!db.sukunaFingers) {
        db.sukunaFingers = { remaining: 20, curses: {} };
        CURSES.slice(0, 20).forEach((c, i) => { db.sukunaFingers.curses[i] = { name: c.name, taken: false, takenBy: null }; });
    }
    if (!db.sukuna) db.sukuna = null;
    if (!db.cullingGame) db.cullingGame = { active: false, colony: null, players: {}, rules: [], startTime: null };
    if (!db.cult) db.cult = { fingers: 0, attacks: 0, lastAttack: 0 };
}

// ── Culling Game ──
const CULLING_COLONIES = [
    'Tokyo Colony No. 1', 'Sendai Colony', 'Sakurajima Colony',
    'Osaka Colony', 'Kyoto Colony', 'Hokkaido Colony',
    'Okinawa Colony', 'Nagoya Colony', 'Fukuoka Colony', 'Sapporo Colony'
];

function ensureCgPlayer(user) {
    if (!user.cullingGame) {
        user.cullingGame = { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: Date.now(), techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null };
    }
}

// ── AI Rule Generator ──
// Generates thematic Culling Game rules from templates, simulating an AI rule-setter.
const RULE_TEMPLATES = {
    restrictions: [
        'No {technique} allowed',
        'All cursed techniques are sealed — only physical combat',
        'CE usage limited to {ce_limit}% of maximum',
        'No domains or barrier techniques',
        'Summons are forbidden',
        'Only weapon-based attacks are permitted',
        'Healing items are banned',
        'Fleeing is prohibited under penalty of instant elimination',
        'All fighters start at 50% HP',
        'Technique cooldowns are doubled',
        'No Ultimate Techniques (UT) allowed',
        'Cursed Energy regeneration is disabled',
        'Only Grade 4 and below techniques may be used',
        'Reverse Cursed Technique is banned',
        'All players share a single HP pool'
    ],
    modifiers: [
        'All damage is multiplied by {mult}x',
        'Critical hits deal {crit}x damage',
        'Guard effectiveness reduced by {guard_reduce}%',
        'Speed determines turn order exclusively',
        'Weapon attack power is doubled',
        'Physical attacks ignore {def_ignore}% of defense',
        'All status effects last {duration}% longer',
        'Every 3rd attack is a guaranteed critical hit',
        'Damage reflection is disabled',
        'Counter-attacks deal {counter}x damage'
    ],
    objectives: [
        'Last sorcerer standing wins',
        'First to reach {points} points wins',
        'Eliminate the clan head to claim victory',
        'Survive {time} minutes to win',
        'Collect {items} cursed objects to win',
        'Defeat {count} enemies without resting',
        'Reach the center of the colony first'
    ]
};

const TECHNIQUE_NAMES = ['Blue', 'Red', 'Purple', 'Infinite Void', 'Malevolent Shrine', 'Heavenly Restriction', 'Limitless', 'Ten Shadows', 'Boogie Woogie', 'Ratio', 'Straw Doll', 'Cursed Speech'];

function generateAIRule() {
    const categories = ['restrictions', 'modifiers', 'objectives'];
    const category = categories[Math.floor(Math.random() * categories.length)];
    let template;
    switch (category) {
        case 'restrictions':
            template = RULE_TEMPLATES.restrictions[Math.floor(Math.random() * RULE_TEMPLATES.restrictions.length)];
            template = template.replace('{technique}', TECHNIQUE_NAMES[Math.floor(Math.random() * TECHNIQUE_NAMES.length)]);
            template = template.replace('{ce_limit}', Math.floor(Math.random() * 50 + 10));
            break;
        case 'modifiers':
            template = RULE_TEMPLATES.modifiers[Math.floor(Math.random() * RULE_TEMPLATES.modifiers.length)];
            template = template.replace('{mult}', (Math.random() * 2 + 0.5).toFixed(1));
            template = template.replace('{crit}', (Math.random() * 3 + 1).toFixed(1));
            template = template.replace('{guard_reduce}', Math.floor(Math.random() * 50 + 10));
            template = template.replace('{def_ignore}', Math.floor(Math.random() * 100));
            template = template.replace('{duration}', Math.floor(Math.random() * 100 + 50));
            template = template.replace('{counter}', (Math.random() * 2 + 1).toFixed(1));
            break;
        case 'objectives':
            template = RULE_TEMPLATES.objectives[Math.floor(Math.random() * RULE_TEMPLATES.objectives.length)];
            template = template.replace('{points}', Math.floor(Math.random() * 500 + 100));
            template = template.replace('{time}', Math.floor(Math.random() * 60 + 10));
            template = template.replace('{items}', Math.floor(Math.random() * 5 + 1));
            template = template.replace('{count}', Math.floor(Math.random() * 10 + 3));
            break;
    }
    return template;
}

// Auto-generate AI rules periodically during the Culling Game
let aiRuleTimer = null;
function startAIRuleGenerator(sock) {
    if (aiRuleTimer) return;
    aiRuleTimer = setInterval(async () => {
        const cg = db.cullingGame;
        if (!cg?.active) {
            clearInterval(aiRuleTimer);
            aiRuleTimer = null;
            return;
        }
        const rule = generateAIRule();
        cg.rules = cg.rules || [];
        if (cg.rules.length >= 10) cg.rules.shift();
        cg.rules.push(rule);
        saveDb();
        broadcastAllGroups(sock, `🤖 *AI RULE GENERATOR*\n\nA new rule has been auto-generated:\n"${rule}"\n\nAll colonies must adapt.`);
    }, 10 * 60 * 1000);
}

async function tickCullingGame(sock) {
    const cg = db.cullingGame;
    if (!cg || !cg.active) return;
    const now = Date.now();
    const INACTIVITY_MS = 70 * 60 * 1000; // 70 minutes
    const PENALTY_DURATION = 4 * 60 * 60 * 1000; // 4 hours

    // 2-hour timer: end the Culling Game and declare the winner
    if (cg.endTime && now > cg.endTime) {
        const players = Object.entries(cg.players || {}).map(([jid, p]) => {
            const pu = db.users[jid];
            const pcg = pu?.cullingGame || {};
            return { jid, points: pcg.points || 0, name: pu?.name || jid.split('@')[0] };
        }).sort((a, b) => b.points - a.points);
        const winner = players[0];
        const winnerName = winner?.name || 'No one';
        const winnerPoints = winner?.points || 0;
        broadcastAllGroups(sock, `🏆 *CULLING GAME — TIME UP!*\n\nThe 2 hours have passed.\n*${winnerName}* wins the Culling Game with *${winnerPoints}* points!\n\nKenjaku now challenges the #1 player on the leaderboard...`);
        const winnerUser = db.users[winner?.jid];
        if (winnerUser) {
            winnerUser.wallet = (winnerUser.wallet || 0) + 10000000;
            winnerUser.xp = (winnerUser.xp || 0) + 500000;
            checkLevelUp(winnerUser);
            try { await sock.sendMessage(winner.jid, { text: `🏆 *CULLING GAME VICTOR!*\nYou won the Culling Game with ${winnerPoints} points!\nRewards: +10,000,000 K-Coins, +500,000 XP`, mentions: [winner.jid] }); } catch {}
        }
        for (const [jid] of Object.entries(cg.players || {})) {
            const u = db.users[jid];
            if (u?.cullingGame) {
                u.cullingGame = { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: Date.now(), techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null };
            }
        }
        cg.active = false;
        cg.players = {};
        cg.rules = [];
        cg.startTime = null;
        cg.endTime = null;
        cg.kenjakuActive = false;
        cg.strongestSealed = false;
        saveDb();

        // Kenjaku event: after the Culling Game ends, seal the #1 player on the leaderboard
        if (!cg.kenjakuPrevented) {
            const lb = getLeaderboardRaw().slice(0, 10);
            const top = lb[0];
            if (top && db.users[top.jid]) {
                const su = db.users[top.jid];
                su.prisonRealm = { sealedBy: 'kenjaku', sealedAt: Date.now(), releasedAt: Date.now() + 24 * 60 * 60 * 1000 };
                ensureFingerState();
                db.sukunaFingers.remaining = 0;
                db.scatteredFingers = 0;
                db.sukunaFingers.curses = {};
                su.fingers = su.fingers || [];
                for (let i = 0; i < 15; i++) {
                    su.fingers.push('kenjaku-' + i + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
                }
                saveDb();
                broadcastAllGroups(sock, `👁️ *KENJAKU APPEARS*\n\n"The strongest sorcerer in the realm has been identified: *${top.name}* (Rank #1).\nThey have been sealed in the *Prison Realm* for 24 hours.\nAll 15 Sukuna Fingers have converged on them.\n\nWhen the Prison Realm seal is broken — by defeat, by Playful Cloud, by Black Rope, or by Limitless — the 15-Finger Sukuna will awaken.\n\n*Sukuna (15 Fingers) vs ${top.name}* — the strongest vs the King of Curses."`);
                try { await sock.sendMessage(top.jid, { text: '🔒 *YOU HAVE BEEN SEALED BY KENJAKU*\n\nKenjaku has identified you as the #1 strongest sorcerer.\nYou are sealed in the Prison Realm for 24 hours.\nAll 15 Sukuna Fingers have converged on you.\nThe final battle between you and 15-Finger Sukuna will begin when you are freed.', mentions: [top.jid] }); } catch {}
            }
        }
        return;
    }

    for (const [jid, p] of Object.entries(cg.players || {})) {
        const u = db.users[jid];
        if (!u) continue;
        ensureCgPlayer(u);
        const cgp = u.cullingGame;
        if (cgp.points > 0 && now - (cgp.lastPointChange || 0) > INACTIVITY_MS && !cgp.penaltyActive) {
            cgp.penaltyActive = true;
            cgp.penaltyUntil = now + PENALTY_DURATION;
            cgp.techniqueLocked = true;
            cgp.techniqueLockUntil = now + PENALTY_DURATION;
            u.stats.Max_HP = Math.floor((u.stats.Max_HP || 120) / 2);
            u.stats.HP = Math.min(u.stats.HP || 0, u.stats.Max_HP);
            u.stats.Max_CE = Math.floor((u.stats.Max_CE || 100) / 2);
            u.stats.CE = Math.min(u.stats.CE || 0, u.stats.Max_CE);
            try { sock.sendMessage(jid, { text: `⏳ *CULLING GAME PENALTY*\nInactivity detected. Your techniques have been removed, max HP/CE halved for 4 hours.` }); } catch {}
        }
        if (cgp.penaltyActive && cgp.penaltyUntil && now > cgp.penaltyUntil) {
            cgp.penaltyActive = false;
            cgp.techniqueLocked = false;
            cgp.techniqueLockUntil = null;
            u.stats.Max_HP = Math.floor((u.stats.Max_HP || 60) * 2);
            u.stats.HP = u.stats.Max_HP;
            u.stats.Max_CE = Math.floor((u.stats.Max_CE || 50) * 2);
            u.stats.CE = u.stats.Max_CE;
            try { sock.sendMessage(jid, { text: `✅ *CULLING GAME PENALTY LIFTED*\nYour techniques and full power have been restored.` }); } catch {}
        }
    }
}

function buildCgStatus(jid) {
    const cg = db.cullingGame;
    if (!cg || !cg.active) return 'The Culling Game is not active.';
    const u = db.users[jid];
    if (!u) return 'Not registered.';
    ensureCgPlayer(u);
    const cgp = u.cullingGame;
    const colony = cgp.colony || cg.colony || 'Unassigned';
    const players = Object.entries(cg.players || {}).map(([jid, p]) => {
        const pu = db.users[jid];
        const name = pu?.name || jid.split('@')[0];
        const pcg = pu?.cullingGame || {};
        return `${name} — ${pcg.points || 0} pts | ${pcg.colony || '?'}`;
    }).sort((a, b) => {
        const pa = parseInt(a.match(/(\d+) pts/) ?.[1] || '0');
        const pb = parseInt(b.match(/(\d+) pts/) ?.[1] || '0');
        return pb - pa;
    });
    let msg = `🌍 *CULLING GAME — ${colony}*\n`;
    msg += `⏳ Started: ${new Date(cg.startTime).toLocaleString()}\n`;
    msg += `📜 Rules applied: ${(cg.rules || []).length}\n`;
    msg += `👤 Your points: ${cgp.points}\n`;
    if (cgp.penaltyActive) msg += `⚠️ PENALTY ACTIVE until ${new Date(cgp.penaltyUntil).toLocaleTimeString()}\n`;
    msg += `\n🏆 *COLONY SCOREBOARD:*\n`;
    players.forEach((line, i) => { msg += `${i + 1}. ${line}\n`; });
    return msg;
}

// Grants a Sukuna finger if the just-defeated curse still hides one. Returns the finger key or null.
function tryGrantFinger(user, enemyName) {
    if (!db.sukunaFingers) return null;
    const entry = Object.entries(db.sukunaFingers.curses).find(([k, f]) => !f.taken && f.name === enemyName);
    if (!entry) return null;
    if (Math.random() > FINGER_DROP_CHANCE) return null;
    const [k, f] = entry;
    f.taken = true;
    f.takenBy = user.player_id || null;
    db.sukunaFingers.remaining = Math.max(0, db.sukunaFingers.remaining - 1);
    user.fingers = user.fingers || [];
    user.fingers.push(k);
    return k;
}

async function broadcastAllGroups(sock, text) {
    for (const id of Object.keys(db.enabledGroups || {})) {
        try {
            const meta = await sock.groupMetadata(id);
            const subject = (meta && meta.subject) ? meta.subject : '';
            if (subject.toUpperCase().includes('KEHN')) {
                await sock.sendMessage(id, { text });
            }
        } catch {}
    }
}

function spawnSukuna(sock, sender, name) {
    db.sukuna = {
        active: true,
        hp: SUKUNA.maxHp, maxHp: SUKUNA.maxHp,
        round: 1, startedBy: sender, startedByName: name,
        players: {}, participants: {}, slain: []
    };
    const msg = '*WHAT....WHAT...WHAT IS THIS FEELING? IS THIS SUKUNA? IS HE FREE? EVERYONE, ITS SUKUNA, HE HAS BEEN REVIVED*\n\nTYPE .accept-s TO ENTER THE RAID. YOU CANNOT FLEE — ONLY DEATH AWAITS. GATHER, SORCERERS.';
    broadcastAllGroups(sock, msg);
    return msg;
}

// Builds a live leaderboard of every user currently holding Sukuna fingers, with
// how many each holds (sorted high -> low). Used by `.search`.
function fingerHoldersView() {
    const holders = Object.entries(db.users)
        .map(([jid, u]) => ({ jid, name: u.name || jid.split('@')[0], count: (u.fingers || []).length }))
        .filter(h => h.count > 0)
        .sort((x, y) => y.count - x.count);
    let line = `\n\n🔥 *FINGER HOLDERS (${holders.length}):*`;
    if (holders.length) {
        holders.slice(0, 20).forEach((h, i) => { line += `\n${i + 1}. ${h.name} — ${h.count} finger${h.count > 1 ? 's' : ''} 👆`; });
    } else {
        line += `\n• No one is holding any fingers yet.`;
    }
    return { line, mentions: holders.map(h => h.jid) };
}

function sukunaRetaliate(raid) {
    const alive = Object.values(raid.players).filter(p => p.hp > 0);
    if (!alive.length) return { domain: false, dmg: 0 };
    const is15 = raid._is15Finger;
    const domainChance = is15 ? 0.35 : 0.18;
    const baseAtk = is15 ? 2500 : 1500;
    const domainDmg = is15 ? 5000 : SUKUNA.domainDmg;
    // Malevolent Shrine — a sure-hit domain that carves through the entire raid.
    if (Math.random() < domainChance) {
        alive.forEach(p => { p.hp = Math.max(0, p.hp - domainDmg); });
        return { domain: true, dmg: domainDmg };
    }
    const target = pick(alive);
    const guarded = !!target.guarding;
    let dmg = Math.floor(baseAtk * (0.8 + Math.random() * 0.6));
    if (guarded) { dmg = Math.floor(dmg * 0.4); target.guarding = false; }
    target.hp = Math.max(0, target.hp - dmg);
    return { target, dmg, guarded };
}

async function endSukunaRaid(sock, won) {
    const raid = db.sukuna;
    const is15 = raid._is15Finger;
    if (won) {
        const xpReward = is15 ? 2000000 : 500000;
        const goldReward = is15 ? 5000000 : 1000000;
        const msg = is15 ? '*15-FINGER SUKUNA HAS BEEN SEALED!*\nTHE KING OF CURSES FALLS.\nEACH PARTICIPANT EARNS +2,000,000 XP AND +5,000,000 K-COINS.' : '*SUKUNA HAS BEEN SEALED!*\nTHE STRONGEST CURSE IN HISTORY FALLS.\nEACH PARTICIPANT EARNS +500,000 XP AND +1,000,000 K-COINS.';
        for (const [jid] of Object.entries(raid.participants || {})) {
            const pu = db.users[jid];
            if (pu) {
                pu.xp += xpReward;
                pu.wallet += goldReward;
                checkLevelUp(pu);
                pu.stats.HP = pu.stats.Max_HP;
                pu.stats.CE = pu.stats.Max_CE;
            }
        }
        const survivors = Object.values(raid.players).map(p => p.name).join(', ') || 'NONE';
        broadcastAllGroups(sock, `${msg}\nSURVIVORS: ${survivors}`);
        db.sukunaFingers = null;
        ensureFingerState();
    }
    db.sukuna = null;
    saveDb();
}

// One raid turn: the player attacks/guards Sukuna, then Sukuna retaliates against the raid.
async function handleRaidTurn(sock, from, sender, user, command) {
    const raid = db.sukuna;
    if (!raid || !raid.active) { await sock.sendMessage(from, { text: '*SUKUNA IS NOT PRESENT.*', mentions: [sender] }); return; }
    const me = raid.players[sender];
    if (!me) { await sock.sendMessage(from, { text: '*YOU ARE NOT IN THE SUKUNA RAID. USE .accept-s*', mentions: [sender] }); return; }
    if (me.hp <= 0) { await sock.sendMessage(from, { text: '*YOU HAVE FALLEN. USE .accept-s TO RE-ENTER THE RAID.*', mentions: [sender] }); return; }

    me.hp = Math.max(me.hp, user.stats.HP); // external heals (.heal / .rct) carry over
    const heroName = me.name;

    let damage = 0, isCrit = false, techDisplayName = null, techEffects = [];
    if (command === 'guard') {
        me.guarding = true;
    } else if (command === 'su') {
        if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '*HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); return; }
        const ownedId = (user.ownedSummons && user.ownedSummons.length) ? user.ownedSummons[user.ownedSummons.length - 1] : null;
        const owned = ownedId != null ? SUMMON_SHOP.find(s => s.id === ownedId) : null;
        if (!owned) { await sock.sendMessage(from, { text: '*YOU HAVE NO BOUND SUMMON. BUY ONE FROM .summonshop OR USE .attack.*', mentions: [sender] }); return; }
        const atk = summonBattleStats(owned, user.grade, user).atk;
        const hp = atk * 6;
        user.summon = { active: true, name: owned.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: owned.move, effect: owned.effect, pl: owned.pl };
        damage = Math.max(1, atk + Math.floor(Math.random() * Math.max(1, Math.floor(atk * 0.3))));
        techDisplayName = owned.move;
        techEffects = [owned.effect];
        if (Math.random() < (user._combat_crit_chance || 0.05)) { damage = Math.floor(damage * 1.5); isCrit = true; }
    } else if (command === 'domain') {
        const canDomain = user.domain_unlocked || user.unlocked_features?.Domain || user.loots?.includes('limitless_six_eyes');
        if (!canDomain) {
            await sock.sendMessage(from, { text: '🌌 *DOMAIN LOCKED.* Reach Grade 2 (or own LIMITLESS & SIX-EYES) and forge one with `.domain-n <name>` to use it here.', mentions: [sender] }); return;
        }
        const stats = getCombatStats(user);
        const isInfiniteVoid = user.loots?.includes('limitless_six_eyes');
        const domainName = isInfiniteVoid ? 'Infinite Void' : (user.domain_unlocked ? (user.domain_name || 'Domain Expansion') : 'Domain Expansion');
        damage = Math.max(1, Math.floor(stats.attack * 4 + 300));
        techDisplayName = domainName;
        techEffects = [`${domainName} carves through Sukuna!`];
        if (Math.random() < (user._combat_crit_chance || 0.05)) { damage = Math.floor(damage * 1.5); isCrit = true; }
    } else if (command === 'attack') {
        const stats = getCombatStats(user);
        damage = Math.max(1, stats.attack + Math.floor(Math.random() * 12));
        const critChance = (user._combat_crit_chance || 0.05);
        if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
        if (user.loots?.includes('black_sparks') && Math.random() < 0.09) {
            damage = Math.floor(damage * 3);
            isCrit = true;
        }
    } else if (command === 'csm-r') {
        if (!user.loots?.includes('cursed_spirit_manipulation')) { await sock.sendMessage(from, { text: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.*', mentions: [sender] }); return; }
        const army = user._cursed_army || [];
        if (!army.length) { await sock.sendMessage(from, { text: '🌀 No curses absorbed yet.', mentions: [sender] }); return; }
        user._cursed_army = [];
        damage = Math.max(1, Math.floor(army.length * 80));
        techDisplayName = 'Maximum: Release';
        techEffects = [`Released ${army.length} absorbed curse spirits to fight Sukuna!`];
    } else if (command === 'cm') {
        if (!user.loots?.includes('copy_mimicry')) { await sock.sendMessage(from, { text: '👁️ *COPY (MIMICRY) REQUIRED.*', mentions: [sender] }); return; }
        const list = user._copied_techniques || [];
        if (!list.length) { await sock.sendMessage(from, { text: '📋 No techniques copied yet.', mentions: [sender] }); return; }
        const idx = parseInt(args[0]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= list.length) { await sock.sendMessage(from, { text: `📋 Invalid slot. Use .cm list.`, mentions: [sender] }); return; }
        const copied = list[idx];
        const casterPower = calcPower(user).attack;
        const baseHit = copied.damage || Math.max(14, Math.floor((copied.cost || 10) * 2));
        const levelBonus = (user.level || 1) * 5;
        damage = Math.max(1, Math.floor(baseHit * 2.0 + casterPower * 1.1) + levelBonus);
        if (copied.double) damage *= 2;
        if (copied.pierce || copied.unblockable || copied.structural) damage = Math.floor(damage * 1.15);
        techDisplayName = `COPY: ${copied.name || 'Mimicked Technique'}`;
        techEffects = [`Yuta/Rika replicate ${copied.name || 'a copied technique'}!`];
        if (Math.random() < 0.15) { damage = Math.floor(damage * 1.3); isCrit = true; }
    } else if (command.startsWith('sk-')) {
        if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ *HEAVENLY RESTRICTION:* You cannot use skills. You wield quirks — use .qk-1 or .qk-2.', mentions: [sender] }); return; }
        const skillNum = parseInt(command.split('-')[1]);
        if (isNaN(skillNum) || skillNum < 1 || skillNum > 10) { await sock.sendMessage(from, { text: 'Usage: .sk-1 through .sk-10', mentions: [sender] }); return; }
        const skills = db.userSkills?.[sender] || [];
        const skillId = skills[skillNum - 1];
        if (!skillId) { await sock.sendMessage(from, { text: `No skill in slot ${skillNum}.`, mentions: [sender] }); return; }
        const skill = CROSS_UNIVERSE_SKILLS[skillId];
        if (!skill) { await sock.sendMessage(from, { text: 'Skill data missing.', mentions: [sender] }); return; }
        const ceCost = skill.ceCost || 0;
        if (!user.heavenly_restriction && user.stats.CE < ceCost) { await sock.sendMessage(from, { text: `[INSUFFICIENT CE: REQUIRES ${ceCost}]`, mentions: [sender] }); return; }
        if (!user.heavenly_restriction) user.stats.CE = Math.max(0, user.stats.CE - ceCost);
        damage = Math.max(1, skill.damage + Math.floor(Math.random() * 10));
        techDisplayName = skill.name;
        techEffects = [skill.desc];
        const critChance = (user._combat_crit_chance || 0.05);
        if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
    } else {
        const tnum = command.match(/([1-4])$/);
        const techKey = tnum ? user['technique_' + tnum[1]] : null;
        const move = INNATE_TECHNIQUES[user.innate_technique_id]?.moves?.[techKey];
        if (!move) { await sock.sendMessage(from, { text: '*TECHNIQUE NOT FOUND.*', mentions: [sender] }); return; }
        const ceCost = Math.max(20, move.cost || 0);
        if (!user.heavenly_restriction && user.stats.CE < ceCost) { await sock.sendMessage(from, { text: `[INSUFFICIENT CE: REQUIRES ${ceCost}]`, mentions: [sender] }); return; }
        if (!user.heavenly_restriction) user.stats.CE = Math.max(0, user.stats.CE - ceCost);
        const fakeEnemy = { name: SUKUNA.name, grade: 0, stats: { HP: raid.hp, Max_HP: raid.maxHp, CE: 99999 } };
        const fakeCombat = { playerStatus: [], enemyIntent: { kind: 'attack', label: 'Slaughter' }, enemyGuarding: false, guarding: false };
        const res = applyTechniqueEffect(move, techKey, user, fakeEnemy, fakeCombat);
        damage = res.damage;
        techEffects = res.narration;
        techDisplayName = getTechDisplayName(techKey);
        const critChance = (user._combat_crit_chance || 0.05);
        if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
    }
    raid.hp = Math.max(0, raid.hp - damage);

    // Released curses (CSM) also attack Sukuna each raid turn
    if (user._cursed_army && user._cursed_army.length > 0) {
        const curseDmg = Math.max(1, user._cursed_army.length * 60);
        raid.hp = Math.max(0, raid.hp - curseDmg);
        techEffects.push(`🌀 ${user._cursed_army.length} released curses strike for ${curseDmg}!`);
    }

    // Bound summon also fights alongside you every raid turn (except on a .su turn, where it IS your action).
    let summonDmg = 0, summonName = null, summonMove = null;
    if (command !== 'su') {
        const ownedId = (user.ownedSummons && user.ownedSummons.length) ? user.ownedSummons[user.ownedSummons.length - 1] : null;
        const owned = ownedId != null ? SUMMON_SHOP.find(s => s.id === ownedId) : null;
        if (owned) {
            const atk = summonBattleStats(owned, user.grade, user).atk;
            const hp = atk * 6;
            user.summon = { active: true, name: owned.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: owned.move, effect: owned.effect, pl: owned.pl };
            summonDmg = Math.max(1, atk + Math.floor(Math.random() * Math.max(1, Math.floor(atk * 0.3))));
            summonName = owned.name;
            summonMove = owned.move;
            if (Math.random() < (user._combat_crit_chance || 0.05)) summonDmg = Math.floor(summonDmg * 1.5);
            raid.hp = Math.max(0, raid.hp - summonDmg);
        }
    }

    if (raid.hp <= 0) { await endSukunaRaid(sock, true); return; }

    const ret = sukunaRetaliate(raid);
    let retMsg = ret.domain
        ? `🌌 *SUKUNA EXPANDS ${SUKUNA.domainName.toUpperCase()}!* A SURE-HIT CARVES THROUGH ALL FIGHTERS FOR ${ret.dmg} DAMAGE!`
        : `👹 SUKUNA STRIKES ${ret.target.name} FOR ${ret.dmg} DAMAGE${ret.guarded ? ' (GUARDED)' : ''}!`;

    const dead = Object.entries(raid.players).filter(([, p]) => p.hp <= 0);
    for (const [pid, p] of dead) {
        const pu = db.users[pid];
        if (pu) { pu.stats.HP = 0; processDefeat(pu, 'standard'); }
        delete raid.players[pid];
        broadcastAllGroups(sock, `SUKUNA HAS ELIMINATED ${p.name.toUpperCase()} AND THE REST ARE STILL FIGHTING, WE NEED HELP`);
    }

    user.stats.HP = Math.max(0, me.hp);
    raid.round++;
    saveDb();

    const aliveCount = Object.keys(raid.players).length;
    await sock.sendMessage(from, {
        text: [
            `☠️ *SUKUNA RAID — ROUND ${raid.round}*`,
            command === 'guard' ? `🛡️ ${heroName} BRACES AGAINST SUKUNA.` : (techDisplayName ? `🧑‍🎓 ${heroName} UNLEASHED *${techDisplayName}*!` : `🧑‍🎓 ${heroName} STRUCK SUKUNA!`),
            `💥 DEALT *${damage}* DAMAGE TO SUKUNA${isCrit ? ' (CRITICAL!)' : ''}`,
            techEffects.length ? `✨ ${techEffects.join(', ')}` : null,
            summonName ? `🐾 ${summonName} (${summonMove}) STRIKES SUKUNA FOR *${summonDmg}*!` : null,
            retMsg,
            `👾 SUKUNA: ${raid.hp}/${raid.maxHp} HP`,
            `🧑‍🎓 ${heroName}: ${Math.max(0, me.hp)}/${me.maxHp} HP`,
            `⚔️ FIGHTERS: ${aliveCount}/${MAX_RAID_PLAYERS}`
        ].filter(Boolean).join('\n'),
        mentions: [sender]
    });
}

// ── Enemy status / affliction system (DoT + stun) ──
function applyEnemyStatus(combat, status) {
    combat.enemyStatus = combat.enemyStatus || [];
    const ex = combat.enemyStatus.find(s => s.type === status.type && s.name === status.name);
    if (ex) { ex.turns = Math.max(ex.turns, status.turns); ex.dot = Math.max(ex.dot || 0, status.dot || 0); }
    else combat.enemyStatus.push({ ...status });
}

function tickEnemyStatus(combat, enemy) {
    combat.enemyStatus = combat.enemyStatus || [];
    const lines = [];
    for (const s of combat.enemyStatus) {
        if (s.dot) {
            let dotVal = Math.max(1, Math.floor(s.dot));
            if (s.scaling && s.baseDot) {
                const elapsed = (s.turns || 1) - 1;
                dotVal = Math.max(1, Math.floor(s.baseDot * (1 + elapsed * 0.5)));
            }
            const dmg = dotVal;
            enemy.stats.HP -= dmg;
            lines.push(`${enemy.name} suffers ${dmg} ${s.name} damage`);
        }
        s.turns -= 1;
    }
    combat.enemyStatus = combat.enemyStatus.filter(s => s.turns > 0);
    return lines;
}

// V2 Boss phase transitions
function checkBossPhaseTransition(combat, enemy) {
    if (!combat.dungeon || !enemy.bossPhases || !enemy.bossPhases.length) return null;
    const currentPhase = enemy.currentPhaseIndex || 0;
    if (currentPhase >= enemy.bossPhases.length) return null;
    const phase = enemy.bossPhases[currentPhase];
    const hpPct = enemy.stats.HP / Math.max(1, enemy.stats.Max_HP);
    if (hpPct <= phase.hpPct && !combat.bossPhaseTriggered?.[currentPhase]) {
        if (!combat.bossPhaseTriggered) combat.bossPhaseTriggered = {};
        combat.bossPhaseTriggered[currentPhase] = true;
        enemy.currentPhaseIndex = (enemy.currentPhaseIndex || 0) + 1;
        // Apply phase effects
        switch (phase.effect) {
            case 'enrage':
                enemy._enrage_until = Date.now() + 30000;
                break;
            case 'blind':
                combat.playerStatus = combat.playerStatus || [];
                combat.playerStatus.push({ name: 'BLIND', turns: 1, evasion: -0.5 });
                break;
            case 'summon':
                combat._boss_minions = (combat._boss_minions || 0) + 2;
                break;
            case 'domain':
                combat.playerDomainBurnout = (combat.playerDomainBurnout || 0) + 2;
                break;
            case 'cleave':
                enemy._cleave_next = true;
                break;
            case 'multi':
                enemy._multi_hit_next = true;
                break;
        }
        return phase;
    }
    return null;
}

// Resolves a player's innate-technique move: applies healing, drains, DoT, stun,
// guards and damage modifiers, then returns the raw hit damage plus narration lines.
function applyTechniqueEffect(move, techKey, user, enemy, combat) {
    const narration = [];
    // Cursed techniques hit HARD. Base damage comes from the move (or a CE-cost floor),
    // then it's amplified by the caster's grade/level power (the single calcPower source)
    // so techniques scale consistently with the rest of the combat system.
    const casterPower = calcPower(user).attack;
    const baseHit = move.damage || Math.max(14, Math.floor((move.cost || 10) * 2));
    const levelBonus = (user.level || 1) * 5;
    let damage = Math.floor(baseHit * 2.0 + casterPower * 1.1) + levelBonus;

    // Damage modifiers
    if (move.double) damage *= 2;
    if (move.multi_hit) damage *= move.multi_hit;
    if (move.area) damage = Math.floor(damage * 1.3);
    if (move.armor_piercing || move.pierce || move.unblockable || move.ignore_defense || move.structural) {
        damage = Math.floor(damage * 1.15);
    }
    if (move.damage_per_token && (user._combat_tokens || 0) > 0) {
        damage += move.damage_per_token * user._combat_tokens;
        narration.push(`spent ${user._combat_tokens} charge(s)`);
        user._combat_tokens = 0;
    }
    if (move.passive_tokens || move.add_token) {
        user._combat_tokens = (user._combat_tokens || 0) + (move.passive_tokens || 1);
        narration.push(`stored a charge (${user._combat_tokens})`);
    }

    // Healing / lifesteal
    if (move.heal) {
        const before = user.stats.HP;
        user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + move.heal);
        if (user.stats.HP > before) narration.push(`restored ${user.stats.HP - before} HP`);
    }
    if (move.steal_hp) {
        damage += move.steal_hp;
        const before = user.stats.HP;
        user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + move.steal_hp);
        narration.push(`drained ${user.stats.HP - before || move.steal_hp} HP`);
    }

    // Cursed-energy manipulation
    if (move.steal_ce) {
        user.stats.CE = Math.min(user.stats.Max_CE, user.stats.CE + move.steal_ce);
        if (typeof enemy.stats.CE === 'number') enemy.stats.CE = Math.max(0, enemy.stats.CE - move.steal_ce);
        narration.push(`siphoned ${move.steal_ce} CE`);
    }
    if (move.buff_max_ce) {
        user.stats.Max_CE += move.buff_max_ce;
        user.stats.CE += move.buff_max_ce;
        narration.push(`expanded max CE by ${move.buff_max_ce}`);
    }

    // Damage-over-time applied to the enemy
    const dotAmt = move.damage_per_turn || move.dot || 0;
    if (dotAmt > 0) {
        const label = move.effect ? String(move.effect).toLowerCase() : 'affliction';
        applyEnemyStatus(combat, { type: 'DOT', name: label, dot: dotAmt, turns: move.turns || 3 });
        narration.push(`inflicted ${label} (${dotAmt}/turn)`);
    }

    // Crowd control: make the enemy skip its next turn(s)
    const stunEffects = ['STUN', 'SKIP_TURN', 'MISS_NEXT', 'IMMOBILIZED', 'MISSFIRE'];
    let stunTurns = 0;
    if (stunEffects.includes(move.effect)) stunTurns = move.turns || 1;
    if (move.paralyze) stunTurns = Math.max(stunTurns, move.paralyze);
    if (move.freeze_target || move.knock_prone || move.remove_entity) stunTurns = Math.max(stunTurns, move.turns || 1);
    if (stunTurns > 0) {
        combat.enemyStunned = Math.max(combat.enemyStunned || 0, stunTurns);
        narration.push(`stunned ${enemy.name} for ${stunTurns} turn(s)`);
    }

    // Defensive setups that soften the enemy's next attack
    if (move.block || move.effect === 'ARMOR' || move.absorb_damage) {
        combat.guarding = true;
        narration.push(move.block ? `braced a guard (block ${move.block})` : `braced for impact`);
    }
    if (move.effect === 'DODGE_NEXT' || move.dodge_attack || move.dodge_any || move.invulnerable || move.teleport_behind || move.teleport_backward) {
        combat.dodgeNext = true;
        narration.push(`positioned to evade the next attack`);
    }

    // Non-damaging debuff flavour so utility moves still read as effective
    if (narration.length === 0 && !move.damage) {
        if (move.reveal_next || move.reveal_traps || move.reveal_hidden || move.reveal_stealth || move.predict_move) narration.push(`read the enemy's next move`);
        else if (move.mark_target || move.apply_thread || move.countdown) narration.push(`marked the target`);
        else narration.push(`shifted the tempo of the fight`);
    }

    return { damage, narration };
}

// Generates a permanent, technique-flavored Domain ability for a user.
function generateDomainAbility(user) {
    const tech = user.innate_technique_id || 'Unknown';
    const techName = tech.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const flavor = [
        'a prison of cursed energy where every strike is guaranteed to connect',
        'a suffocating field that drains the foe of strength',
        'a reality-bending expanse that bends to your technique',
        'a coffin of manifestation where the enemy cannot evade'
    ];
    const desc = `A Domain imbued with ${techName}. While expanded it delivers ${pick(flavor)}, guaranteeing your hits land and weakening the foe for 2 rounds.`;
    return { technique: tech, techniqueName: techName, desc };
}

function getSummonDescription(summonName, actionType, damage) {
    if (actionType === 'strike') {
        return `${summonName} lunged with a spectral strike, tearing at the hostile entity.`;
    }
    if (actionType === 'taunt') {
        return `${summonName} drew aggressive attention, shielding its master from harm.`;
    }
    if (actionType === 'soak') {
        return `${summonName} absorbed the brunt of the enemy assault.`;
    }
    return `${summonName} acted, interfering with the hostile threat.`;
}

function executeSummonPhase(user, enemy) {
    if (!user.summon?.active) return { log: '', summonDamage: 0, summonSoak: 0 };
    const summon = user.summon;
    const actionRoll = Math.random();
    let summonDamage = 0;
    let summonSoak = 0;
    let actionType = 'strike';
    if (actionRoll < 0.5) {
        summonDamage = Math.max(1, (summon.atk || 5) + Math.floor(Math.random() * 5));
        actionType = 'strike';
    } else if (actionRoll < 0.8) {
        summonSoak = Math.max(1, Math.floor((enemy.stats?.atk || 10) * 0.4));
        actionType = 'soak';
        if (summon.HP > summonSoak) summon.HP -= summonSoak;
        else { summon.HP = 0; summon.active = false; }
    } else {
        actionType = 'taunt';
    }
    const desc = getSummonDescription(summon.name, actionType, summonDamage);
    return { log: `🐾 SUMMON: ${desc}\n💥 SUMMON OUTPUT: -${summonDamage} DMG${summonSoak ? ` | 🛡️ SOAK: -${summonSoak} DMG` : ''}`, summonDamage, summonSoak };
}

const CARD_WIDTH = 800;
const CARD_HEIGHT = 500;
const BAR_WIDTH = 320;
const BAR_HEIGHT = 22;

function drawBar(ctx, x, y, current, max, color) {
    const pct = Math.max(0, Math.min(1, current / Math.max(1, max)));
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x, y, BAR_WIDTH, BAR_HEIGHT);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, BAR_WIDTH * pct, BAR_HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(x, y, BAR_WIDTH, BAR_HEIGHT);
}

async function generateProfileCard(user, profilePicBuffer) {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
    const bg = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const bgCtx = bg.getContext('2d');
    const grad = bgCtx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    grad.addColorStop(0, '#0f0f1a');
    grad.addColorStop(1, '#1a0f0f');
    bgCtx.fillStyle = grad;
    bgCtx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    ctx.drawImage(bg, 0, 0);

    ctx.strokeStyle = '#7a1c1c';
    ctx.lineWidth = 6;
    ctx.strokeRect(24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48);
    ctx.strokeStyle = '#2a0a0a';
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, CARD_WIDTH - 68, CARD_HEIGHT - 68);

    // Draw a random curse entity
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(580, 220, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(560, 210, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(600, 210, 12, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px monospace';
    ctx.fillText('KENNYJAKS : STUDENT ID', 240, 110);
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(240, 120);
    ctx.lineTo(CARD_WIDTH - 50, 120);
    ctx.stroke();

    const startY = 160;
    const gap = 46;
    ctx.font = '26px monospace';
    ctx.fillStyle = '#ffffff';
    const nameText = `NAME: ${user.name}`;
    const titleText = `TITLE: ${user.title}`;
    const rankText = `RANK: ${user.alignment} | GRADE: ${user.grade}`;
    const levelText = `LEVEL: ${user.level} (${user.xp}/${user.xp_needed} XP)`;
    ctx.fillText(nameText, 240, startY);
    ctx.fillText(titleText, 240, startY + gap);
    ctx.fillText(rankText, 240, startY + gap * 2);
    ctx.fillText(levelText, 240, startY + gap * 3);

    const hpY = startY + gap * 4 + 10;
    ctx.fillStyle = '#ff4d4d';
    ctx.font = 'bold 22px monospace';
    ctx.fillText('VITALITY', 240, hpY);
    drawBar(ctx, 240, hpY + 10, user.stats.HP, user.stats.Max_HP, '#ff4d4d');
    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    ctx.fillText(`${user.stats.HP} / ${user.stats.Max_HP} HP`, 580, hpY + 18);

    const ceY = hpY + 60;
    ctx.fillStyle = '#4da6ff';
    ctx.font = 'bold 22px monospace';
    ctx.fillText('ENERGY', 240, ceY);
    const ceDisplay = user.loots?.includes('limitless_six_eyes') ? '∞' : `${user.stats.CE} / ${user.stats.Max_CE}`;
    drawBar(ctx, 240, ceY + 10, user.stats.CE, user.stats.Max_CE, '#4da6ff');
    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    ctx.fillText(`${ceDisplay} CE`, 580, ceY + 18);

    const vaultY = ceY + 60;
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 22px monospace';
    ctx.fillText(`VAULT: ${user.wallet} K-Coins`, 240, vaultY);

    const summonLine = user.summon?.active ? `SUMMON: ${user.summon.name} (${user.summon.HP}/${user.summon.Max_HP} HP)` : 'SUMMON: None';
    const shopLine = user.shop?.has_shop ? `COMMERCE: ${user.shop.name} at [${user.shop.node}]` : 'COMMERCE: None';
    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    ctx.fillText(summonLine, 240, vaultY + 46);
    ctx.fillText(shopLine, 240, vaultY + 92);

    return canvas.toBuffer('image/png');
}

async function generateCombatCard(user, enemy, round, logs) {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
    const bg = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const bgCtx = bg.getContext('2d');
    const grad = bgCtx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    grad.addColorStop(0, '#1a0f0f');
    grad.addColorStop(1, '#0f0f1a');
    bgCtx.fillStyle = grad;
    bgCtx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    ctx.drawImage(bg, 0, 0);

    ctx.strokeStyle = '#7a1c1c';
    ctx.lineWidth = 6;
    ctx.strokeRect(24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48);
    ctx.strokeStyle = '#2a0a0a';
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, CARD_WIDTH - 68, CARD_HEIGHT - 68);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px monospace';
    ctx.fillText('KENNYJAKS : BATTLE', 50, 80);

    const zone = user.current_node || 'Unknown';
    ctx.fillStyle = '#ffcc00';
    ctx.font = '24px monospace';
    ctx.fillText(`ZONE: ${zone} | ROUND: ${round}`, 50, 120);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(`SORCERER: ${user.name}`, 50, 160);
    drawBar(ctx, 50, 170, user.stats.HP, user.stats.Max_HP, '#ff4d4d');
    drawBar(ctx, 50, 196, user.stats.CE, user.stats.Max_CE, '#4da6ff');
    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    const ceText = user.loots?.includes('limitless_six_eyes') ? '∞ CE' : `${user.stats.CE}/${user.stats.Max_CE} CE`;
    ctx.fillText(`${user.stats.HP}/${user.stats.Max_HP} HP  ${ceText}`, 380, 186);

    const summonLine = user.summon?.active ? `${user.summon.name} | ${user.summon.HP}/${user.summon.Max_HP} HP` : 'SUMMON: None';
    ctx.fillText(summonLine, 50, 236);

    ctx.fillStyle = '#ff6666';
    ctx.font = 'bold 24px monospace';
    ctx.fillText(`HOSTILE: ${enemy.name}`, 50, 272);
    drawBar(ctx, 50, 282, enemy.stats.HP, enemy.stats.Max_HP, '#ff4d4d');
    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    ctx.fillText(`${enemy.stats.HP}/${enemy.stats.Max_HP} HP`, 380, 298);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(50, 320);
    ctx.lineTo(CARD_WIDTH - 50, 320);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = '22px monospace';
    const logLines = (logs || '').split('\n').slice(0, 6);
    logLines.forEach((line, idx) => ctx.fillText(line, 50, 350 + idx * 26));

    return canvas.toBuffer('image/png');
}

function textBar(current, max, width = 20) {
    const pct = Math.max(0, Math.min(1, current / Math.max(1, max)));
    const filled = Math.round(width * pct);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function gradeEmoji(g) {
    if (g == null) return '';
    if (g === 0) return '🛑 Special Grade';
    if (g === 1) return '🔴 Grade 1';
    if (g === 2) return '🟠 Grade 2';
    if (g === 3) return '🟡 Grade 3';
    return '🟢 Grade 4';
}

function threatLabel(grade) {
    if (grade == null) return 'UNKNOWN';
    if (grade === 0) return 'EXTREME';
    if (grade === 1) return 'HIGH';
    if (grade === 2) return 'ELEVATED';
    if (grade === 3) return 'MODERATE';
    return 'LOW';
}

function statusLine(statuses) {
    if (!statuses || !statuses.length) return 'None';
    return statuses.map(s => `${s.name}${s.turns ? ` (${s.turns})` : ''}`).join(', ');
}

function buildCombatText({ combat, user, enemy, heroName, damage, techDisplayName, techEffects, phase, isCrit, isDodge, enemyDotLines, summonResult, location }) {
    const enemyGrade = enemy.grade ?? 4;
    const enemyGradeLabel = gradeEmoji(enemyGrade);
    const enemyThreat = threatLabel(enemyGrade);
    const enemyHP = Math.max(0, enemy.stats.HP);
    const enemyMaxHP = enemy.stats.Max_HP || 1;
    const enemyPct = Math.round((enemyHP / enemyMaxHP) * 100);
    const enemyBar = textBar(enemyHP, enemyMaxHP, 20);
    const enemyDef = Math.max(0, Math.floor((enemy.stats?.def || enemy.stats?.defense || 0)));
    const enemyStatus = statusLine(combat.enemyStatus);

    const playerHP = Math.max(0, user.stats.HP);
    const playerMaxHP = user.stats.Max_HP || 1;
    const playerCE = Math.max(0, user.stats.CE);
    const playerMaxCE = user.stats.Max_CE || 1;
    const playerPct = Math.round((playerHP / playerMaxHP) * 100);
    const playerCEPct = Math.round((playerCE / playerMaxCE) * 100);
    const playerHPBar = textBar(playerHP, playerMaxHP, 20);
    const playerCEBar = textBar(playerCE, playerMaxCE, 20);
    const playerGradeLabel = gradeEmoji(user.grade ?? 4);
    const weaponName = user.weapon?.name || 'None';
    const playerStatus = statusLine(combat.playerStatus);

    const lines = [];
    lines.push('┌─────────────────────────────────────────────────────┐');
    const title = combat.darkRegion ? '🌑 DARK CONTINENT — CURSE ENCOUNTER' : '🌀 CURSE ENCOUNTER 🌀';
    const titlePadded = ' ' + title + ' ';
    const titleSpaces = Math.max(0, 57 - titlePadded.length);
    const titleLine = titlePadded + ' '.repeat(titleSpaces);
    lines.push('│' + titleLine + '│');
    lines.push('├─────────────────────────────────────────────────────┤');
    lines.push(`  📍 LOCATION : ${location || user.current_node || 'Unknown'}`);
    lines.push('');
    lines.push(`  👾 TARGET   : ${enemy.name}  [${enemyGradeLabel}]`);
    lines.push(`  ❤️ HP       : ${enemyBar}  ${enemyHP.toLocaleString()}/${enemyMaxHP.toLocaleString()}  (${enemyPct}%)`);
    lines.push(`  ☣️ THREAT   : 🛑 ${enemyThreat}${' '.repeat(Math.max(1, 10 - enemyThreat.length))}| 🛡️ DEF: +${enemyDef}`);
    if (enemyStatus !== 'None') lines.push(`  ⚠️ STATUS   : [${enemyStatus}]`);
    lines.push('');
    lines.push(' ─────────────────────────────────────────────────────');
    lines.push(`  👤 YOU      : ${heroName}  [${playerGradeLabel}]`);
    lines.push(`  ❤️ HP       : ${playerHPBar}  ${playerHP.toLocaleString()}/${playerMaxHP.toLocaleString()}  (${playerPct}%)`);
    lines.push(`  ⚡ CE       : ${playerCEBar}  ${playerCE}/${playerMaxCE}  (${playerCEPct}%)`);
    lines.push(`  🗡️ EQUIPPED : ${weaponName}`);
    if (playerStatus !== 'None') lines.push(`  ⚠️ STATUS   : [${playerStatus}]`);
    lines.push('└─────────────────────────────────────────────────────┘');

    lines.push('  💬 COMBAT LOG:');
    if (techDisplayName) {
        const action = isDodge ? 'whiffed' : (damage > 0 ? `unleashed *${techDisplayName}*` : `used *${techDisplayName}*`);
        lines.push(`  ▸ ${heroName} ${action}!`);
    } else {
        lines.push(`  ▸ ${heroName} attacked!`);
    }
    if (techEffects && techEffects.length) {
        techEffects.forEach(eff => lines.push(`  ▸ ${eff}`));
    }
    if (damage > 0 && !isDodge) {
        lines.push(`  ▸ Dealt *${damage}* damage to ${enemy.name}!${isCrit ? ' (CRITICAL!)' : ''}${isCounter ? ' (COUNTER!)' : ''}`);
    } else if (isDodge) {
        lines.push(`  ▸ ...but ${enemy.name} slipped away — no damage!`);
    }
    if (enemyDotLines && enemyDotLines.length) {
        enemyDotLines.forEach(dot => lines.push(`  ▸ ${dot}`));
    }
    if (summonResult && summonResult.log) {
        lines.push(`  ▸ ${summonResult.log}`);
    }
    if (phase && !phase.stunned && !phase.domain && phase.eDamage > 0) {
        lines.push(`  ▸ ${enemy.name} struck back for *${phase.eDamage}* damage!${phase.guarded ? ' (GUARDED)' : ''}`);
    } else if (phase && !phase.stunned && !phase.domain && phase.eDamage === 0) {
        lines.push(`  ▸ ${heroName} evaded the counterattack!`);
    }
    if (phase && phase.stunned) {
        lines.push(`  ▸ ${enemy.name} is stunned and cannot retaliate!`);
    }
    if (phase && phase.domain) {
        lines.push(`  ▸ ${enemy.name} expanded DOMAIN — *${phase.domainName}*!`);
    }

    lines.push(' ─────────────────────────────────────────────────────');
    lines.push('  🎮 COMMAND ACTIONS:');
    const cmds = combat.darkRegion
        ? ['.attack', '.technique-1..5', '.guard', '.flee', '.su', '.wa', '.move', '.rct']
        : ['.attack', '.technique-1..5', '.guard', '.flee', '.rct', '.su', '.domain'];
    cmds.forEach((c, i) => {
        const pad = ' '.repeat(Math.max(1, 22 - c.length));
        if (i % 2 === 0 && i + 1 < cmds.length) {
            lines.push(`  ▸ ${c}${pad}▸ ${cmds[i + 1]}`);
        } else if (i % 2 === 0) {
            lines.push(`  ▸ ${c}`);
        }
    });
    lines.push('└─────────────────────────────────────────────────────┘');
    return lines.join('\n');
}

function generateGambleCard(user, color, outcome, multiplier, amount) {
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');
    const bg = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const bgCtx = bg.getContext('2d');
    const grad = bgCtx.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    grad.addColorStop(0, '#1a0f0f');
    grad.addColorStop(1, '#0f0f1a');
    bgCtx.fillStyle = grad;
    bgCtx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
    ctx.drawImage(bg, 0, 0);

    ctx.strokeStyle = '#7a1c1c';
    ctx.lineWidth = 6;
    ctx.strokeRect(24, 24, CARD_WIDTH - 48, CARD_HEIGHT - 48);
    ctx.strokeStyle = '#2a0a0a';
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, CARD_WIDTH - 68, CARD_HEIGHT - 68);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px monospace';
    ctx.fillText('CURSED CASINO', 50, 80);

    ctx.fillStyle = '#ffcc00';
    ctx.font = '24px monospace';
    ctx.fillText(`BET: ${amount} K-Coins on ${color.toUpperCase()}`, 50, 120);

    ctx.fillStyle = multiplier >= 0 ? '#00ff00' : '#ff0000';
    ctx.font = 'bold 40px monospace';
    ctx.fillText(`MULTIPLIER: x${multiplier}`, 50, 200);

    ctx.fillStyle = '#ffffff';
    ctx.font = '28px monospace';
    ctx.fillText(`OUTCOME: ${outcome}`, 50, 260);

    const net = amount * multiplier;
    ctx.fillStyle = net >= 0 ? '#00ff00' : '#ff0000';
    ctx.font = '24px monospace';
    ctx.fillText(`NET: ${net >= 0 ? '+' : ''}${net} K-Coins`, 50, 320);

    return canvas.toBuffer('image/png');
}

async function sendProfileCard(sock, from, user, sender) {
    let summonLine;
    if (user.ownedSummons && user.ownedSummons.length) {
        const names = user.ownedSummons.map(id => { const s = SUMMON_SHOP.find(x => x.id === id); return s ? `${s.name} (PL ${fmtNum(s.pl)})` : 'Unknown'; });
        summonLine = `🐾 BOUND SUMMON: ${names.join(', ')}${user.summon?.active ? ` — ACTIVE: ${user.summon.name}` : ''}`;
    } else {
        summonLine = user.summon?.active ? `🐾 SUMMON: ${user.summon.name} (🩺 ${user.summon.HP}/${user.summon.Max_HP} HP)` : '🐾 SUMMON: None';
    }
    const shopLine = user.shop?.has_shop ? `🏪 COMMERCE: ${user.shop.name} at [${user.shop.node}]` : '🏪 COMMERCE: None';
    const clanObj = user.clan ? findClanByName(user.clan) : null;
    const clanLine = clanObj ? `🏯 CLAN: ${clanObj.name}${clanObj.head === (user.player_id) ? ' (Head)' : ''}` : '🏯 CLAN: None';
    const rctLine = user.custom_technique ? `🩹 RCT TECHNIQUE: ${user.custom_technique.name} (120 ATK DMG)` : '🩹 RCT TECHNIQUE: None (unlock via .t5r)';
    const owned = (user.loots || []).map(id => LOOTS[id]?.name).filter(Boolean);
    const lootLine = owned.length ? `🎁 LOOT: ${owned.join(', ')}` : '🎁 LOOT: None';
    let skillLine;
    if (user.heavenly_restriction) {
        const quirks = user.quirks || [];
        skillLine = quirks.length ? `⛓️ QUIRKS: ${quirks.map(q => q.name).join(', ')}` : '⛓️ QUIRKS: None (explore Dark Continent)';
    } else {
        const skills = db.userSkills?.[sender] || [];
        skillLine = skills.length ? `📚 SKILLS: ${skills.length}/10` : '📚 SKILLS: None (find scrolls in Dark Continent)';
    }
    const caption = `KENNYJAKS : STUDENT ID\n👤 ${user.name}\n🎖️ ${user.title}\n📊 ${user.alignment} | GRADE: ${user.grade}\n📈 LEVEL: ${user.level} (${fmtNum(user.xp)}/${fmtNum(user.xp_needed)} XP)\n🩸 VITALITY: ${user.stats.HP}/${user.stats.Max_HP}\n⚡ ENERGY: ${ceFor(user)}\n🧠 SANITY: ${user.sanity ?? 100}%\n🛡️ STANCE: ${user.stance ?? 100}%\n🪙 VAULT: ${fmtNum(user.wallet)} K-Coins\n${clanLine}\n${summonLine}\n${rctLine}\n${lootLine}\n${skillLine}\n${shopLine}`;
    try {
        const pp = await sock.profilePictureUrl(sender, 'image');
        let ppBuf = null;
        try {
            const res = await fetch(pp);
            // undici can emit a stray 'error' on the response body stream that
            // escapes the await; attach a no-op handler so it rejects cleanly.
            if (res && res.body && typeof res.body.on === 'function') res.body.on('error', () => {});
            ppBuf = await res.buffer();
        } catch { ppBuf = null; }
        const buf = await generateProfileCard(user, ppBuf);
        await sock.sendMessage(from, { image: buf, caption, mentions: [sender] });
    } catch {
        const buf = await generateProfileCard(user, null);
        await sock.sendMessage(from, { image: buf, caption, mentions: [sender] });
    }
}

async function sendCombatCard(sock, from, user, enemy, round, logs) {
    const buf = await generateCombatCard(user, enemy, round, logs);
    await sock.sendMessage(from, { image: buf, caption: 'KENNYJAKS : BATTLE\nAction Paths: .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .rct [val] | .domain', mentions: [user.player_id] });
}

async function startBot(deviceId = 'main', phoneNumber = null) {
    const sessionDir = getSessionDir(deviceId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({ logger: pino({ level: 'silent' }), auth: state, browser: ['Kennyjaks', 'Chrome', '10.0.0'], markOnlineOnConnect: false });
    BOT_SOCK = sock;
    // ── Anti-ban protocol ──
    // Every outbound message is queued and paced: a global minimum gap between ANY two
    // messages, a per-chat gap, a per-minute ceiling, and small random jitter. This keeps
    // the account's send cadence human-like and comfortably under WhatsApp's automation
    // thresholds (high-volume / constant-burst sending is the #1 ban trigger).
    const _origSendMessage = sock.sendMessage.bind(sock);
    const antiBanCfg = config.antiBan || {};
    const AB = {
        enabled: antiBanCfg.enabled !== false,
        globalMinIntervalMs: antiBanCfg.globalMinIntervalMs ?? 500,
        jidMinIntervalMs: antiBanCfg.jidMinIntervalMs ?? 900,
        perMinuteCap: antiBanCfg.perMinuteCap ?? 30,
        maxQueue: antiBanCfg.maxQueue ?? 80,
        jitterMs: antiBanCfg.jitterMs ?? 250,
    };
    const _sendQueue = [];
    let _draining = false;
    let _lastGlobalSend = 0;
    const _jidLastSend = {};
    const _minuteStamps = [];
    const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
    function _abStats() { return { enabled: AB.enabled, queued: _sendQueue.length, perMinute: _minuteStamps.length, limits: { ...AB } }; }
    async function _drainQueue() {
        if (_draining) return;
        _draining = true;
        try {
            while (_sendQueue.length) {
                const job = _sendQueue.shift();
                const now = Date.now();
                while (_minuteStamps.length && now - _minuteStamps[0] > 60000) _minuteStamps.shift();
                let wait = 0;
                if (AB.perMinuteCap > 0 && _minuteStamps.length >= AB.perMinuteCap) {
                    wait = Math.max(wait, 60000 - (now - _minuteStamps[0]));
                }
                wait = Math.max(wait, AB.globalMinIntervalMs - (now - _lastGlobalSend));
                const jl = _jidLastSend[job.jid] || 0;
                wait = Math.max(wait, AB.jidMinIntervalMs - (now - jl));
                wait += Math.random() * AB.jitterMs;
                if (wait > 0) await _sleep(wait);
                try {
                    const ts = Date.now();
                    _lastGlobalSend = ts;
                    _jidLastSend[job.jid] = ts;
                    _minuteStamps.push(ts);
                    const res = await _origSendMessage(job.jid, job.content, job.options);
                    job.resolve(res);
                } catch (e) {
                    job.reject(e);
                }
            }
        } finally {
            _draining = false;
        }
    }
    sock.sendMessage = (jid, content, options = {}) => {
        if (sock._quotedMsg && (options == null || options.quoted === undefined)) {
            options = { ...(options || {}), quoted: sock._quotedMsg };
        }
        if (!AB.enabled) return _origSendMessage(jid, content, options);
        // Overflow guard: drop the oldest queued message rather than let the queue grow
        // without bound during a burst (losing one cosmetic line beats a rate-limit ban).
        if (_sendQueue.length >= AB.maxQueue) {
            const dropped = _sendQueue.shift();
            if (dropped) dropped.resolve(undefined);
        }
        return new Promise((resolve, reject) => {
            _sendQueue.push({ jid, content, options, resolve, reject });
            _drainQueue();
        });
    };
    sock.antiBanStats = _abStats;
    sock.ev.on('creds.update', saveCreds);
    console.log(`[${deviceId}] Session: ${sessionDir}`);

    // Run clan upkeep once on boot and hourly thereafter (guarded so only one timer runs).
    try { initWorld(); } catch (e) { logger.error({ err: e }, 'initWorld error'); }
            try { processClanMaintenance(); } catch (e) { logger.error({ err: e }, 'clan maintenance error'); }
    if (!clanMaintenanceTimer) {
        clanMaintenanceTimer = setInterval(() => {
    try { processClanMaintenance(); } catch (e) { logger.error({ err: e }, 'clan maintenance error'); }
        }, 60 * 60 * 1000);
    }
    if (!worldTimer) {
        worldTimer = setInterval(() => {
            tickWorldLife(BOT_SOCK);
        }, 5 * 60 * 1000);
    }
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr, user }) => {
        if (connection === 'connecting') {
            console.log(`[${deviceId}] Connecting...`);
            if (phoneNumber && !state.creds.registered) {
                config.devices[deviceId] = phoneNumber.replace(/[^0-9]/g, '');
                saveConfig();
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                        console.log(`[${deviceId}] Pairing code: ${code}`);
                    } catch (e) {
                        logger.error({ err: e, deviceId }, 'Pairing failed');
                    }
                }, 2000);
            }
        }
        if (qr && !phoneNumber) { console.log(`[${deviceId}] Scan QR:`); qrcode.generate(qr, { small: true }); }
        if (connection === 'open') {
            const connJid = user?.id || user?.jid;
            const connNum = jidNum(connJid);
            const expected = config.devices[deviceId] ? jidNum(config.devices[deviceId]) : null;
                if (expected && connNum && expected !== connNum) {
                    logger.error({ deviceId, connJid, expected }, '[SECURITY] HIJACK ATTEMPT');
                    try { await sock.logout(); } catch {}
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
                return;
            }
            if (!config.devices[deviceId] && connJid) {
                config.devices[deviceId] = connJid;
                saveConfig();
            }
            BOT_JID = connJid;
            BOT_SOCK = sock;
            if (connJid && !mods.some(m => sameJid(m, connJid))) {
                mods.push(connJid);
                saveMods();
                console.log(`[${deviceId}] Bot number auto-added as mod:`, connJid);
            }
            console.log(`[${deviceId}] Connected! User:`, user);
        }
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401 && lastDisconnect?.error?.output?.statusCode !== 403) setTimeout(() => startBot(deviceId, phoneNumber), 5000);
    });

    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        if (action === 'add' && db.enabledGroups[id]) {
            const metadata = await sock.groupMetadata(id);
            for (const p of participants) {
                const pp = await sock.profilePictureUrl(p, 'image').catch(() => null);
                const msg = `Welcome *${jidDecode(p)?.user || p.split('@')[0]}* to *${metadata.subject}*!\n\n${metadata.desc || 'No description'}\n\nCurse or Fighter?`;
                pp ? await sock.sendMessage(id, { image: { url: pp }, caption: msg, mentions: [p] }) : await sock.sendMessage(id, { text: msg, mentions: [p] });
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const m of messages) {
          try {
            if (!m.message || m.key.remoteJid === 'status@broadcast') continue;
            if (m.key.fromMe) continue;
            const from = m.key.remoteJid, sender = m.key.participant || from;
            const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
            const _ctx = m.message?.extendedTextMessage?.contextInfo;
            const mentioned = (_ctx?.mentionedJid || []).filter(j => !sameJid(j, sender));
            const quotedParticipant = _ctx?.participant;

            let sourceImageMsg = null;
            if (m.message.imageMessage) {
                sourceImageMsg = m;
            } else if (_ctx?.quotedMessage) {
                const qm = _ctx.quotedMessage;
                if (qm.imageMessage || qm.stickerMessage) sourceImageMsg = { message: qm };
            }

            if (!body.startsWith(PREFIX)) continue;
            sock._quotedMsg = m;
            const args = body.slice(PREFIX.length).trim().split(/\s+/), command = args.shift().toLowerCase();

             // ── Security gate ──
             if (isBanned(sender)) continue;
             
             const spamCount = recMessage(sender);
            if (spamCount > 15) { await kickOff(sock, from, sender, 'Message flood / spam attack'); continue; }
            if (spamCount > 8) recIntrusion(sender, 'spam', 1);

            const now = Date.now();
            const lastAt = lastCmdAt.get(sender);
            if (lastAt && now - lastAt < 10000 && !isMod(sender)) {
                const wait = Math.ceil((10000 - (now - lastAt)) / 1000);
                await sock.sendMessage(from, { text: `⏳ *COOLDOWN:* Wait ${wait}s before using another command.`, mentions: [sender] });
                continue;
            }
            lastCmdAt.set(sender, now);

            const user = db.users[sender];
            const combat = db.combats[sender];

            if (user && user.heavenly_restriction) {
                if (!('_bonus_attack' in user)) user._bonus_attack = 200;
                if (!('_bonus_defense' in user)) user._bonus_defense = 200;
                user.innate_technique_id = user.innate_technique_id || 'Heavenly Restriction';
                user.skills = user.skills || INNATE_TECHNIQUES['Heavenly Restriction']?.moves || {};
                user.technique_1 = user.technique_1 || 'heavy_slash';
                user.technique_2 = user.technique_2 || 'clap_smash';
                user.technique_3 = user.technique_3 || 'super_fast_slash';
                user.technique_4 = user.technique_4 || 'divine_axe_slash';
                user.technique_5 = user.technique_5 || 'ricochet_throw';
                user.technique_6 = user.technique_6 || 'parry_counter';
                if (!Array.isArray(user.quirks) || user.quirks.length === 0) {
                    user.quirks = pickRandomQuirks(2);
                }
            }

             // ── Unregistered guard: unless this is a registration / help command, tell them to register first. ──
             const _regCmds = ['start', 'reg-curse', 'reg-fighter', 'register', 'menu', 'help', 'story', 'p', 'profile'];
             if (!user || !user.registered) {
                 if (!_regCmds.includes(command)) {
                     await sock.sendMessage(from, { text: '👋 *NEW HERE?* Register to unlock the full JJK RPG experience!\n\n' +
                         '1️⃣ Type *.start* to begin your journey\n' +
                         '2️⃣ Choose *.reg-curse* (Curse User) or *.reg-fighter* (Sorcerer)\n' +
                         '3️⃣ Set your name with *.register <name>*\n\n' +
                         '📋 Use *.menu* to see all commands\n' +
                         '❓ Use *.help* for a full guide\n' +
                         '📖 Use *.story* to learn the lore\n\n' +
                         'Once registered, explore Tokyo, fight curses, and unlock techniques!', mentions: [sender] });
                     continue;
                 }
             }

              // ── Prison Realm seal check: sealed users cannot do anything ──
              if (user && user.prisonRealm && Date.now() < (user.prisonRealm.releasedAt || 0)) {
                  const remaining = Math.max(0, Math.ceil((user.prisonRealm.releasedAt - Date.now()) / 1000));
                  const hours = Math.floor(remaining / 3600);
                  const mins = Math.floor((remaining % 3600) / 60);
                  await sock.sendMessage(from, { text: `🔒 *BRO YOU ARE IN THE PRISON REALM*\nYou are sealed away for ${hours}h ${mins}m more.\nThe only way out is for someone to defeat your captor in PvP using Playful Cloud or Black Rope, or for a Limitless user to defeat them.`, mentions: [sender] });
                  continue;
              }

              // ── Culling Game restrictions: only PvP and curse fighting allowed ──
              if (db.cullingGame?.active && db.cullingGame.players[sender]) {
                  const cgAllowed = ['ch', 'ch-a', 'ch-end', 'b-curse', 'cg-status', 'cg-leave', 'attack', 'technique-1', 'technique-2', 'technique-3', 'technique-4', 'technique-5', 'technique-6', 'ut-1', 'ut-2', 'ut-3', 'ut-4', 'guard', 'flee', 'wa', 'wa1', 'wa2', 'wa3', 'wa4', 'wa5', 'wa6', 'qk-1', 'qk-2', 'heal', 'fish', 'profile', 'p', 'stats', 'inventory', 'equip', 'unequip', 'rct', 'su'];
                  if (!cgAllowed.includes(command) && !command.startsWith('sk-')) {
                      await sock.sendMessage(from, { text: '⚔️ *CULLING GAME RESTRICTION:* Only PvP and curse fighting are allowed!\nAllowed: .ch .ch-a .ch-end .b-curse .attack .technique-1..6 .guard .flee .wa .qk-1 .qk-2 .heal .fish .profile .stats .inventory .equip .unequip .rct .su .cg-status .cg-leave', mentions: [sender] });
                      continue;
                  }
              }

             // Check if the strongest Culling Game player was just freed — trigger Sukuna final battle
             if (db.cullingGame?.strongestSealed && db.cullingGame.strongestJid && !db.sukuna?.active) {
                 const strongestUser = db.users[db.cullingGame.strongestJid];
                 if (strongestUser && (!strongestUser.prisonRealm || Date.now() >= (strongestUser.prisonRealm.releasedAt || 0))) {
                     db.cullingGame.strongestSealed = false;
                     db.cullingGame.strongestJid = null;
                     saveDb();
                     broadcastAllGroups(sock, `⚔️ *THE FINAL BATTLE BEGINS*\n\nThe Prison Realm seal has been broken!\n*15-Finger Sukuna vs The Strongest Player*\n\nAll 15 Sukuna Fingers have converged.\nThe King of Curses awakens in his full glory!\n\nUse .accept-s to challenge 15-Finger Sukuna!`);
                     setTimeout(() => {
                         if (!db.sukuna?.active) {
                             spawnSukuna(sock, db.cullingGame?.strongestJid || strongestUser.player_id, strongestUser.name || 'The Strongest');
                             db.sukuna._is15Finger = true;
                             db.sukuna.maxHp = 1500000;
                             db.sukuna.hp = 1500000;
                             db.sukuna.domainDmg = 5000;
                             db.sukuna.atk = 2500;
                             saveDb();
                             broadcastAllGroups(sock, `👹 *15-FINGER SUKUNA HAS AWAKENED!*\n\n"Foolish sorcerers... You think you can challenge ME?\nI am the King of Curses!\nCome — let me show you true despair."\n\nTYPE .accept-s TO ENTER THE RAID.\nHP: 1,500,000 | ATK: 2,500 | DOMAIN: 5,000 DMG`);
                         }
                     }, 3000);
                 }
             }

            // ── Quest answering via .q-<answer> (works even mid-combat) ──
            if (command.startsWith('q-')) {
                if (!db.activeQuest || !db.activeQuest.active) {
                    await sock.sendMessage(from, { text: '*NO ACTIVE QUEST.* Use .quests to post one.', mentions: [sender] }); continue;
                }
                if (!user) { await sock.sendMessage(from, { text: 'Register first (.reg-fighter / .reg-curse) to claim quest rewards.', mentions: [sender] }); continue; }
                const answerText = body.slice(PREFIX.length + 2).trim(); // everything after ".q-"
                 if (normalizeAnswer(answerText) === normalizeAnswer(db.activeQuest.answer)) {
                     const xpBoost = getArmorEffect(user, 'xp_boost') || 0;
                     user.xp += Math.floor(4000 * (1 + xpBoost));
                     user.wallet += 500000;
                    user.skill_points = (user.skill_points || 0) + 1;
                    checkLevelUp(user);
                    const solved = db.activeQuest;
                    db.activeQuest = null;
                    saveDb();
                    const winner = user.name || sender.split('@')[0];
                    broadcastAllGroups(sock, `*QUEST SOLVED!*\n${winner.toUpperCase()} ANSWERED CORRECTLY: "${solved.answer.toUpperCase()}"\nREWARD: +4,000 XP AND +5,000,000 GOLD.`);
                } else {
                    await sock.sendMessage(from, { text: '*INCORRECT ANSWER.* The quest remains open — try again or let another sorcerer solve it.', mentions: [sender] });
                }
                continue;
            }
            
            if (user && user.active_curse_spawn) {
                const elapsed = Date.now() - user.active_curse_spawn.spawnedAt;
                if (elapsed > 60000) {
                    user.active_curse_spawn = null;
                    saveDb();
                }
            }
            if (combat) {
                const allowed = ['attack', 'technique-1', 'technique-2', 'technique-3', 'technique-4', 'technique-5', 'technique-6', 'ut-1', 'ut-2', 'ut-3', 'ut-4', 'guard', 'flee', 'vow', 'bu', 'co', 'rct', 'domain', 'domain-n', 'jk', 'taunt', 'su', 'wa', 'wa1', 'wa2', 'wa3', 'wa4', 'wa5', 'wa6', 'b-invite', 'b-i-a', 'ch-end', 'sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6', 'sk-7', 'sk-8', 'sk-9', 'sk-10', 'bf', 'gb', 'cm', 'bw', 'csm', 'csm-r', 'it', 'jd', 'jd1', 'heal', 'fish', 'profile', 'p', 'stats', 'inventory', 'equip', 'unequip', 'upgrade', 'summon', 'summonshop', 'tq', 't5r', 'skills', 'l-skills', 'achievements', 'titles', 'story', 'menu', 'help', 'lb', 'daily', 'quests', 'search', 'sukuna', 'accept-s', 'guild', 'clan', 'map', 'villages', 'colonise', 'set-taxes', 'de-col', 'v-a', 'dmap', 'explore', 'engage-r', 'leave-region', 'g-k-gojo', 'cg', 'cg-status', 'cg-rules', 'cg-rule', 'cg-invite', 'cg-leave', 'wallet', 'withdraw', 'deposit', 'gamble', 'gamble-red', 'gamble-green', 'gamble-blue', 'gamble-black', 'qk-1', 'qk-2', 'waeq', 'subs', 'sub', 'sanity', 'stance', 'move'];
                const isAllowed = allowed.includes(command) || command.startsWith('sbuy-') || command.startsWith('gamble-') || command.startsWith('cg-') || command.startsWith('clan-') || command.startsWith('give-') || command.startsWith('sf-') || command.startsWith('loot-') || command.startsWith('rem-') || command.startsWith('shop-') || command.startsWith('domain-') || command.startsWith('sk-') || command.startsWith('ut-') || command.startsWith('technique-') || command.startsWith('csm');
                if (!isAllowed) {
                    await sock.sendMessage(from, { text: '⚔️ *COMBAT RESTRICTION:* Only battle commands allowed.\nAllowed: .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .ut-1 | .ut-2 | .ut-3 | .ut-4 | .qk-1 | .qk-2 | .flee'   , mentions: [sender] }); continue;
                }
            }

            // COMEDIAN burnout: after .co, the user can only use .attack for 30 seconds.
            if (user && Date.now() < (user._comedian_burnout_until || 0) && command !== 'attack' && !['menu', 'help', 'p', 'profile', 'wallet', 'lb', 'daily', 'accept-s'].includes(command)) {
                const remaining = Math.max(0, user._comedian_burnout_until - Date.now());
                const secs = Math.ceil(remaining / 1000);
                await sock.sendMessage(from, { text: `🎭 *COMEDIAN BURNOUT:* You can only use .attack for the next ${secs}s.`   , mentions: [sender] }); continue;
            }

            // ── PvP duel routing: if the sender is mid a PvP duel, route battle
            // commands into the PvP engine instead of (or before) PvE combat. ──
            const PVP_MOVES = ['attack', 'technique-1', 'technique-2', 'technique-3', 'technique-4', 'technique-5', 'technique-6', 'ut-1', 'ut-2', 'ut-3', 'ut-4', 'guard', 'rct', 'domain', 'flee', 'wa', 'wa1', 'wa2', 'wa3', 'wa4', 'wa5', 'wa6', 'sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6', 'sk-7', 'sk-8', 'sk-9', 'sk-10', 'bu', 'co', 'vow', 'jk', 'taunt', 'qk-1', 'qk-2', 'csm', 'csm-r', 'cm', 'bw', 'it', 'jd'];
            if (PVP_MOVES.includes(command) && getPvpMatch(from, sender)) {
                await handlePvpTurn(sock, from, sender, user, command, args);
                continue;
            }

            if (combat && combat.missionFight) {
                const npcCombatCommands = ['attack', 'technique-1', 'technique-2', 'technique-3', 'technique-4', 'technique-5', 'technique-6', 'ut-1', 'ut-2', 'ut-3', 'ut-4', 'guard', 'flee', 'rct', 'domain', 'su', 'wa', 'wa1', 'wa2', 'wa3', 'wa4', 'wa5', 'wa6', 'bu', 'co', 'vow', 'gb', 'cm', 'bw', 'csm', 'csm-r', 'it', 'jd', 'jd1', 'sk-1', 'sk-2', 'sk-3', 'sk-4', 'sk-5', 'sk-6', 'sk-7', 'sk-8', 'sk-9', 'sk-10', 'qk-1', 'qk-2'];
                if (npcCombatCommands.includes(command) || command.startsWith('sk-') || command.startsWith('qk-') || command.startsWith('csm')) {
                    await handleNpcFight(sock, from, sender, user, command, args);
                    continue;
                }
            }

            if (user && !combat && !getPvpMatch(from, sender)) {
                user.command_count = (user.command_count || 0) + 1;
                if (user.command_count % 5 === 0) {
                    const inc = checkIncursion(user);
                    if (inc.active) {
                        db.combats[sender] = { player: user, enemy: inc.enemy, round: 1, ambush: true, weaponOnly: true, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, host: sender, participants: [sender] };
                        saveDb();
                        await sock.sendMessage(from, { text: `⚠️ *WINDOW OF VULNERABILITY DETECTED*\n───\n> **EVENT:** SORCERER_AMBUSH\n> **LOCATION:** ${inc.location}\n───\n_*Type .attack to defend*_\n👁️ It's preparing: ${enemyIntentHint(db.combats[sender].enemyIntent)}`   , mentions: [sender] }); continue;
                    }
                }
            }

            if (command === 'start') {
                if (db.users[sender]?.registered) { await sock.sendMessage(from, { text: 'Already registered. Use .p.'  , mentions: [sender] }); continue; }
                await sock.sendMessage(from, { text: '*KENNYJAKS: Open-World Jujutsu RPG*\n`.reg-curse` - Curse User\n`.reg-fighter` - Jujutsu Sorcerer'   , mentions: [sender] });
            }

             else if (command === 'reg-curse') {
                if (db.users[sender]?.registered) { await sock.sendMessage(from, { text: 'You are already registered.', mentions: [sender] }); continue; }
                const tech = getRandomTechnique('Curse');
                const moves = INNATE_TECHNIQUES[tech]?.moves || {};
                db.users[sender] = { ...initPlayer(sender, 'Curse', tech) };
                db.users[sender].alignment = 'Curse User';
                saveDb();
                await sock.sendMessage(from, { text: `*Curse User Selected!*\nTechnique: ${tech}\nType \`.register <name>\` to set username.`   , mentions: [sender] });
            }

            else if (command === 'reg-fighter') {
                if (db.users[sender]?.registered) { await sock.sendMessage(from, { text: 'You are already registered.', mentions: [sender] }); continue; }
                const tech = getRandomTechnique('Fighter');
                const moves = INNATE_TECHNIQUES[tech]?.moves || {};
                db.users[sender] = { ...initPlayer(sender, 'Sorcerer', tech) };
                db.users[sender].alignment = 'Sorcerer';
                saveDb();
                await sock.sendMessage(from, { text: `*Jujutsu Sorcerer Selected!*\nTechnique: ${tech}\nType \`.register <name>\` to set username.`   , mentions: [sender] });
            }

            else if (command === 'register' && args[0]) {
                if (!user) { await sock.sendMessage(from, { text: 'Choose alignment first.'  , mentions: [sender] }); continue; }
                if (user.registered && user.name) { await sock.sendMessage(from, { text: 'You are already registered.', mentions: [sender] }); continue; }
                user.name = args[0];
                user.registered = true;
                saveDb();
                await sock.sendMessage(from, { text: `Registered as *${args[0]}*!`   , mentions: [sender] });
            }

            else if (command === 'set-name' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'You must register first (.start).', mentions: [sender] }); continue; }
                const old = user.name;
                user.name = args[0];
                saveDb();
                await sock.sendMessage(from, { text: `✏️ *NAME UPDATED*\n${old || 'Unknown'} → *${args[0]}*`, mentions: [sender] });
            }

            else if (command === 'cm') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if (!user.loots?.includes('copy_mimicry')) { await sock.sendMessage(from, { text: '👁️ *COPY (MIMICRY) REQUIRED.* You need the COPY loot.', mentions: [sender] }); continue; }
                const list = user._copied_techniques || [];
                if (!list.length) { await sock.sendMessage(from, { text: '📋 No techniques copied yet. Defeat enemies (not HR users) to copy their strongest technique.', mentions: [sender] }); continue; }
                let msg = `📋 *COPIED TECHNIQUES*\n`;
                list.forEach((c, i) => { msg += `${i + 1}. *${c.name || c._key}* (DMG ${c.damage || 0} | CE ${c.cost || 0})\n`; });
                msg += `\nUse *.cm <number>* in combat to unleash.`;
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

            else if (command === 'p' || command === 'profile') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                await sendProfileCard(sock, from, user, sender);
            }

             else if (command === 'tq') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 if (user.heavenly_restriction) {
                     const quirks = user.quirks || [];
                     let msg = `⛓️ *HEAVENLY RESTRICTION — QUIRKS* (${quirks.length}/2)\n`;
                     if (quirks.length === 0) {
                         msg += 'No quirks awakened yet. Explore the Dark Continent to awaken quirks.\n';
                     } else {
                         quirks.forEach((q, i) => {
                             msg += `\n${i + 1}. *${q.name}* (.qk-${i + 1})\n   ${q.desc}\n`;
                         });
                     }
                     msg += `\n💡 Use *.qk-1* and *.qk-2* in combat to unleash your quirks.`;
                     await sock.sendMessage(from, { text: msg, mentions: [sender] });
                     continue;
                 }
                 const keys = [user.technique_1, user.technique_2, user.technique_3, user.technique_4].filter(Boolean);
                 let msg = `╔══════════════════════════════════════╗\n   🌀 ${user.name}'s TECHNIQUES\n╚══════════════════════════════════════╝\n`;
                 msg += `🧬 Innate Technique: *${user.innate_technique_id || 'None'}*\n──────────────────────────────────────────\n`;
                 if (keys.length === 0) {
                     msg += 'No techniques learned yet.\n';
                 } else {
                     keys.forEach((k, i) => {
                         const move = user.skills && user.skills[k];
                         const name = move?.name || getTechDisplayName(k);
                         const detail = move ? `DMG ${move.damage || 0} | CE ${move.cost || 0}${move.effect ? ' | ' + move.effect : ''}` : '';
                         msg += `${i + 1}. *${name}* (.technique-${i + 1})\n   ${detail}\n`;
                     });
                 }
                 msg += `──────────────────────────────────────────\n`;
                 msg += `🗡️ Weapon: ${user.weapon ? user.weapon.name + ' (.wa = ' + (user.wa_attack || 6) + ')' : 'None — buy from .shops'}`;
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
             }

             else if (command === 'summon') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                 if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); continue; }
                 const summonTypes = [
                    { name: 'Cursed Spirit Companion', maxHp: 80, atk: 12, ce: 60 },
                    { name: 'Raven Informant', maxHp: 60, atk: 8, ce: 40 },
                    { name: 'Shikigami', maxHp: 100, atk: 15, ce: 70 }
                ];
                if (!user.summon?.active) {
                    const choice = summonTypes[Math.floor(Math.random() * summonTypes.length)];
                    const stats = getCombatStats(user);
                    const atk = Math.max(5, Math.floor(stats.attack * 0.35));
                    const maxHp = atk * 5;
                    user.summon = {
                        active: true,
                        name: choice.name,
                        HP: maxHp,
                        Max_HP: maxHp,
                        CE: choice.ce,
                        Max_CE: choice.ce,
                        atk: atk
                    };
                    saveDb();
                    await sock.sendMessage(from, { text: `🐾 *SUMMON ACTIVATED*\n${choice.name} has been bound to your cursed energy.\nHP: ${maxHp} | ATK: ${atk} | CE: ${choice.ce}`   , mentions: [sender] });
                } else {
                    user.summon.active = false;
                    user.summon.name = 'None';
                    user.summon.HP = 0;
                    user.summon.Max_HP = 0;
                    saveDb();
                     await sock.sendMessage(from, { text: '🐾 *SUMMON DISMISSED*'   , mentions: [sender] });
                }
            }

              else if (command === 'summonshop') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); continue; }
                  db.soldSummons = db.soldSummons || {};
                  let msg = '🐾 *KENNYJAKS SUMMON SHOP* 🐾\nOne-of-a-kind familiars — once claimed, gone forever.\nBuy with *.sbuy-<number>*\n──────────────────────────';
                  for (const s of SUMMON_SHOP) {
                      const sold = db.soldSummons[s.id];
                      const cost = getSummonCost(s.pl);
                      const status = sold ? '❌ SOLD OUT' : `🪙 ${fmtNum(cost)} K-Coins`;
                      msg += `\n\n${s.id}. *${s.name}* [${s.tier}]\n   ${status} | PL: ${fmtNum(s.pl)}\n   💥 ${s.move}\n   📝 ${s.effect}`;
                  }
                  await sock.sendMessage(from, { text: msg, mentions: [sender] });
              }

              else if (command.startsWith('sbuy-')) {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You cannot use summons.', mentions: [sender] }); continue; }
                  const id = parseInt(command.slice(5));
                 const item = SUMMON_SHOP.find(s => s.id === id);
                 if (!item) { await sock.sendMessage(from, { text: 'Invalid summon id. Use *.summonshop*.', mentions: [sender] }); continue; }
                 db.soldSummons = db.soldSummons || {};
                 if (db.soldSummons[item.id]) { await sock.sendMessage(from, { text: `*SOLD OUT*: ${item.name} was already claimed by another sorcerer and can never return.`, mentions: [sender] }); continue; }
                 const cost = getSummonCost(item.pl);
                 if (user.wallet < cost) { await sock.sendMessage(from, { text: `Need ${fmtNum(cost)} K-Coins. You have ${fmtNum(user.wallet)}.`, mentions: [sender] }); continue; }
                 user.wallet -= cost;
                 // One-summon rule: any summon the user already owns is returned to the shop before binding the new one.
                 const prev = (user.ownedSummons || []).slice();
                 for (const oid of prev) releaseSummonToShop(user, oid);
                 setSingleSummon(user, item.id, item);
                 const atk = Math.max(20, Math.round(item.pl / 200));
                 const hp = atk * 6;
                 saveDb();
                 await sock.sendMessage(from, { text: `🐾 *SUMMON CLAIMED!*\n*${item.name}* is now bound to your cursed energy.\n🪙 -${fmtNum(cost)} K-Coins\n⚔️ ATK: ${atk} | HP: ${hp}\n${prev.length ? `↩️ Your previous summon${prev.length > 1 ? 's' : ''} returned to the shop for sale.\n` : ''}This manifestation is one-of-a-kind and can never be claimed again.`, mentions: [sender] });
             }

             else if (command === 'lb') {
                 await sock.sendMessage(from, { text: getLeaderboard()   , mentions: [sender] });
             }

             else if (command === 'players') {
                 await sock.sendMessage(from, { text: getAllPlayers()   , mentions: [sender] });
             }

            else if (command === 'ch') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                if (getPvpMatch(from, sender)) { await sock.sendMessage(from, { text: '*YOU ARE ALREADY IN A DUEL.* Finish it first.', mentions: [sender] }); continue; }
                const slot = db.pvp[from] = db.pvp[from] || {};
                if (slot.pending && Date.now() > (slot.pending.expires || 0)) slot.pending = null;
                if (slot.started) { await sock.sendMessage(from, { text: '*A DUEL IS ALREADY IN PROGRESS HERE.*', mentions: [sender] }); continue; }
                // Resolve the target from a mention or a replied-to message.
                let target = mentioned[0] || quotedParticipant;
                if (!target) {
                    const raw = (args[0] || '').replace(/[^0-9]/g, '');
                    if (raw) target = `${raw}@s.whatsapp.net`;
                }
                if (!target) { await sock.sendMessage(from, { text: '*TAG A SORCERER TO CHALLENGE.*\nUsage: `.ch @user` (mention or reply to them).', mentions: [sender] }); continue; }
                if (sameJid(target, sender)) { await sock.sendMessage(from, { text: '*YOU CANNOT CHALLENGE YOURSELF.*', mentions: [sender] }); continue; }
                const tUser = db.users[target];
                if (!tUser || !tUser.registered) { await sock.sendMessage(from, { text: '*THAT SORCERER IS NOT REGISTERED.* They must use `.reg-curse` / `.reg-fighter` first.', mentions: [sender] }); continue; }
                if (getPvpMatch(from, target)) { await sock.sendMessage(from, { text: '*THAT SORCERER IS ALREADY DUELING.*', mentions: [sender] }); continue; }
                slot.pending = { challenger: sender, challenged: target, expires: Date.now() + 120000 };
                saveDb();
                await sock.sendMessage(from, {
                    text: `🥊 *DUEL CHALLENGE!*\n${pvpDisplayName(sender)} has challenged ${pvpDisplayName(target)}!\nType *.ch-a* to accept. (Expires in 2 minutes)`,
                    mentions: [sender, target]
                });
            }

            else if (command === 'ch-a') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                const slot = db.pvp[from];
                if (!slot || !slot.pending || Date.now() > (slot.pending.expires || 0)) { await sock.sendMessage(from, { text: '*NO PENDING CHALLENGE.* No one has challenged you (or it expired).', mentions: [sender] }); continue; }
                if (!sameJid(slot.pending.challenged, sender)) { await sock.sendMessage(from, { text: '*THIS CHALLENGE IS NOT FOR YOU.*', mentions: [sender] }); continue; }
                if (getPvpMatch(from, sender)) { await sock.sendMessage(from, { text: '*YOU ARE ALREADY IN A DUEL.*', mentions: [sender] }); continue; }
                const challenger = slot.pending.challenger;
                if (!db.users[challenger] || !db.users[challenger].registered) { await sock.sendMessage(from, { text: '*THE CHALLENGER IS NO LONGER REGISTERED.*', mentions: [sender] }); continue; }
                await startPvpMatch(sock, from, challenger, sender);
            }

            else if (command === 'ch-end') {
                const slot = db.pvp[from];
                if (!slot) { await sock.sendMessage(from, { text: '*NO ACTIVE DUEL HERE.*', mentions: [sender] }); continue; }
                if (slot.started) {
                    if (slot.p1 !== sender && slot.p2 !== sender) { await sock.sendMessage(from, { text: '⛔ You are not a participant in this duel.', mentions: [sender] }); continue; }
                    const aName = pvpDisplayName(slot.p1), bName = pvpDisplayName(slot.p2);
                    delete db.pvp[from];
                    saveDb();
                    await sock.sendMessage(from, { text: `🏳️ *DUEL ENDED.* ${aName} vs ${bName} was ended by ${pvpDisplayName(sender)}.`, mentions: [slot.p1, slot.p2] });
                } else if (slot.pending) {
                    const involved = sameJid(slot.pending.challenger, sender) || sameJid(slot.pending.challenged, sender);
                    if (!involved) { await sock.sendMessage(from, { text: '⛔ You are not part of this challenge.', mentions: [sender] }); continue; }
                    const other = sameJid(slot.pending.challenger, sender) ? slot.pending.challenged : slot.pending.challenger;
                    delete db.pvp[from];
                    saveDb();
                    await sock.sendMessage(from, { text: `🏳️ *CHALLENGE CANCELLED.* ${pvpDisplayName(sender)} withdrew the duel invitation.`, mentions: [sender, other] });
                } else {
                    await sock.sendMessage(from, { text: '*NO ACTIVE DUEL HERE.*', mentions: [sender] });
                }
            }

               else if (command === 'attack' || command === 'technique-1' || command === 'technique-2' || command === 'technique-3' || command === 'technique-4' || command === 'technique-5' || command === 'ut-1' || command === 'ut-2' || command === 'ut-3' || command === 'ut-4' || command === 'su' || command === 'domain' || command === 'wa' || command === 'bu' || command === 'co' || command === 'vow' || command === 'gb' || command === 'cm' || command === 'bw' || command === 'csm' || command === 'csm-r' || command.startsWith('csm') || command === 'it' || command === 'jd' || command === 'qk-1' || command === 'qk-2' || command.startsWith('sk-')) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await handleRaidTurn(sock, from, sender, user, command); continue; }
                const combat = db.combats[sender];
                if (!combat) { await sock.sendMessage(from, { text: 'No combat.'  , mentions: [sender] }); continue; }
                const { enemy } = combat;
                const bleedLines = tickCombatStatus(combat, user);
                // DOMAIN CLASH burnout: the loser can only use basic attacks for 2 rounds.
                if ((combat.playerDomainBurnout || 0) > 0 && !['attack', 'guard', 'flee', 'rct'].includes(command)) {
                    await sock.sendMessage(from, { text: '🔥 *DOMAIN CLASH BURNOUT:* Your CE is scorched — only .attack / .guard / .flee work for 2 rounds.'  , mentions: [sender] }); continue;
                }
                // Regeneration: recover HP each turn.
                if (user._skills?.passive_heal) user.stats.HP = Math.min(user.stats.Max_HP, (user.stats.HP || 0) + user._skills.passive_heal);
                // JACKPOT: infinite HP for 40s — bleed can't break the window either.
                if (user.loots?.includes('jackpot') && Date.now() < (user._jackpot_until || 0)) user.stats.HP = user.stats.Max_HP;
                if (user.stats.HP <= 0) {
                    // Immortal: survive one fatal blow per battle with 1 HP.
                    if (user._skills?.survival > 0 && !combat._immortalUsed) {
                        combat._immortalUsed = true;
                        user.stats.HP = 1;
                        await sock.sendMessage(from, { text: '♾️ *IMMORTAL* — you narrowly survive a lethal blow with 1 HP!'  , mentions: [sender] });
                    } else {
                        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                        if (r === 'ended' || r === 'knocked') continue;
                    }
                }
                let damage = 0;
                let isCrit = false;
                let isDodge = false;
                let isCounter = false;
                let techKey = null;
                let move = null;
                let techDisplayName = null;
                let techEffects = [];
                let playerDmgMult = combat.enemyGuarding ? 0.5 : 1;
                combat.enemyGuarding = false;
                if (command === 'attack') {
                    combat.weaponOnly = false;
                     if (user.heavenly_restriction) {
                         const stats = getCombatStats(user);
                         damage = Math.max(1, stats.attack + Math.floor(Math.random() * 12));
                         const critChance = (user._combat_crit_chance || 0.05);
                         if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                         if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                     } else {
                        const stats = getCombatStats(user);
                        damage = Math.max(1, stats.attack + Math.floor(Math.random() * 12));
                        if (user.loots?.includes('black_sparks')) damage = Math.floor(damage * 1.15);
                        const critChance = (user._combat_crit_chance || 0.05) * (combatHasStatus(combat, 'BLIND') ? 0.5 : 1);
                        if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                        if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                        if (user.loots?.includes('black_sparks') && Math.random() < 0.09) {
                            damage = Math.floor(damage * 3);
                            combat.enemyStunned = Math.max(combat.enemyStunned || 0, 1);
                            techDisplayName = 'BLACK FLASH';
                            techEffects = ['⚡ BLACK FLASH! Triple damage + 1-round stun!'];
                            isCrit = true;
                        }
                        if (combat.counter_state && Math.random() < 0.3) { damage = Math.floor(damage * 1.8); isCounter = true; combat.counter_state = false; }
                    }
                } else if (command === 'su') {
                    combat.weaponOnly = false;
                    const ownedId = (user.ownedSummons && user.ownedSummons.length) ? user.ownedSummons[user.ownedSummons.length - 1] : null;
                    const owned = ownedId != null ? SUMMON_SHOP.find(s => s.id === ownedId) : null;
                    if (!owned) { await sock.sendMessage(from, { text: '🐾 *NO SUMMON BOUND.* Buy one from .summonshop first.', mentions: [sender] }); continue; }
                    const atk = summonBattleStats(owned, user.grade, user).atk;
                    const hp = atk * 6;
                    user.summon = { active: true, name: owned.name, HP: hp, Max_HP: hp, CE: 120, Max_CE: 120, atk, move: owned.move, effect: owned.effect, pl: owned.pl };
                    // Rika: infinite CE for 5 minutes + beam attack
                    if (ownedId === 20) {
                        user._rika_mode = true;
                        user._rika_until = Date.now() + 5 * 60 * 1000;
                        user.stats.CE = user.stats.Max_CE;
                        damage = Math.max(1, Math.floor((user.summon.atk || 135000) * 0.4) + 5000);
                        techDisplayName = 'Rika: Cursed Energy Beam';
                        techEffects = ['💍 Rika manifests — infinite CE for 5 minutes. Beam strike hits for massive damage!'];
                    } else {
                        damage = Math.max(1, user.summon.atk + Math.floor(Math.random() * Math.max(1, Math.floor(user.summon.atk * 0.3))));
                        techDisplayName = user.summon.move;
                        techEffects = [user.summon.effect];
                    }
                    const critChance = (user._combat_crit_chance || 0.05);
                    if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                    if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                } else if (command === 'domain') {
                    combat.weaponOnly = false;
                    const canDomain = user.domain_unlocked || user.unlocked_features?.Domain || user.loots?.includes('limitless_six_eyes');
                    if (!canDomain) {
                        if ((user.grade ?? 4) > 2) {
                            await sock.sendMessage(from, { text: '🌌 *DOMAIN LOCKED.* Reach Grade 2 to unlock Domain creation, or obtain LIMITLESS & SIX-EYES.'  , mentions: [sender] }); continue;
                        }
                        await sock.sendMessage(from, { text: '🌌 *DOMAIN NOT FORGED.* You unlocked Domain at Grade 2 — give it a name with `.domain-n <name>` (in battle) to forge it, then use `.domain`.'  , mentions: [sender] }); continue;
                    }
                    const stats = getCombatStats(user);
                    const isInfiniteVoid = user.loots?.includes('limitless_six_eyes');
                    const domainName = isInfiniteVoid ? 'Infinite Void' : (user.domain_unlocked ? (user.domain_name || 'Domain Expansion') : 'Domain Expansion');
                    damage = Math.max(1, Math.floor(stats.attack * 4 + 300));
                    techDisplayName = domainName;
                    techEffects = [`${domainName}: a sure-hit domain that guarantees its strike connects.`];
                    isCrit = true;
                    // DOMAIN CLASH: if the curse can also expand a domain, the two domains collide.
                    // The bot randomly picks the winner; the loser suffers 2 rounds of CE burnout
                    // (can only use basic attacks) while the winner's domain dominates.
                    if (enemy.canDomain) {
                        const clashWinner = Math.random() < 0.5 ? 'player' : 'enemy';
                        if (clashWinner === 'player') {
                            combat.enemyDomainBurnout = 2;
                            techEffects.push(`⚔️ DOMAIN CLASH! You overpower ${enemy.name}'s domain — it collapses, leaving the curse in CE burnout for 2 rounds (attacks only)!`);
                        } else {
                            combat.playerDomainBurnout = 2;
                            techEffects.push(`⚔️ DOMAIN CLASH! ${enemy.name}'s domain overpowers yours — you suffer CE burnout for 2 rounds (attacks only)!`);
                        }
                    }
                 } else if (command === 'wa' || /^wa[1-6]$/.test(command)) {
                     let weaponSlot = null;
                     if (command !== 'wa') {
                         const slotIdx = parseInt(command.slice(2)) - 1;
                         const owned = user.weapons_owned || [];
                         if (slotIdx < 0 || slotIdx >= owned.length) {
                             await sock.sendMessage(from, { text: `🗡️ No weapon in slot ${slotIdx + 1}. You own ${owned.length} weapon(s). Use .waeq <num> to equip.`, mentions: [sender] });
                             continue;
                         }
                         weaponSlot = owned[slotIdx];
                     }
                     const activeWeapon = weaponSlot || user.weapon;
                     if (!activeWeapon) { await sock.sendMessage(from, { text: '🗡️ *NO WEAPON EQUIPPED.* Buy one from .shops (it equips automatically on purchase).', mentions: [sender] }); continue; }
                     if (weaponSlot) user.weapon = weaponSlot;
                     // Weapon strike keeps weaponOnly true; any technique/.attack above already set it false.
                     const wAtk = user.wa_attack || 6;
                     damage = Math.max(1, wAtk + Math.floor(Math.random() * Math.max(1, Math.floor(wAtk * 0.25))));
                     techDisplayName = activeWeapon.name;
                     techEffects = [activeWeapon.effect];
                     const critChance = (user._combat_crit_chance || 0.05);
                     if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                     if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                 } else if (command === 'bu') {
                    if (!user.loots?.includes('blood_manipulation')) { await sock.sendMessage(from, { text: '🩸 *BLOOD MANIPULATION REQUIRED.* You need the BLOOD MANIPULATION loot to use .bu.', mentions: [sender] }); continue; }
                    const ceCost = 25;
                    if (user.stats.CE < ceCost) { await sock.sendMessage(from, { text: `[⚠️ INSUFFICIENT CE: .bu REQUIRES ${ceCost}]`, mentions: [sender] }); continue; }
                    user.stats.CE = Math.max(0, user.stats.CE - ceCost);
                    const bStats = getCombatStats(user);
                    // Piercing Blood: supersonic armor-piercing kinetic beam — ignores the enemy guard.
                    combat.enemyGuarding = false;
                    playerDmgMult = 1;
                    damage = Math.max(1, Math.floor(bStats.attack * 1.8));
                    techDisplayName = 'Piercing Blood';
                    techEffects = ['Supersonic armor-piercing kinetic blood beam — bypasses the enemy guard.'];
                    const critChance = (user._combat_crit_chance || 0.05);
                    if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                    if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                } else if (command === 'co') {
                    if (!user.loots?.includes('comedian')) { await sock.sendMessage(from, { text: '🎭 *COMEDIAN REQUIRED.* You need the COMEDIAN loot to use .co.', mentions: [sender] }); continue; }
                    if (Date.now() < (user._comedian_burnout_until || 0)) { await sock.sendMessage(from, { text: '🎭 *COMEDIAN BURNT OUT.* You can only use .attack during burnout.', mentions: [sender] }); continue; }
                    // A funny thought becomes absolute reality: attacks used on you fail for 60s,
                    // then a 30s burnout where only .attack is usable.
                    user._comedian_until = Date.now() + 60000;
                    user._comedian_burnout_until = Date.now() + 30 * 1000;
                    damage = 0; isDodge = true;
                    techDisplayName = 'Comedian';
                    techEffects = ['A funny thought becomes absolute reality — attacks used on you fail for 60s. 30s burnout begins (only .attack usable).'];
                } else if (command === 'vow') {
                    if (!user.loots?.includes('entropys_loom')) { await sock.sendMessage(from, { text: '🔮 *ENTROPY’S LOOM REQUIRED.* You need the ENTROPY’S LOOM loot to use .vow.', mentions: [sender] }); continue; }
                    user._vow_until = Date.now() + 120000;
                    damage = 0; isDodge = true;
                    techDisplayName = 'Vow of Ruin';
                    techEffects = ['You sacrifice healing for 3 turns — all enemy healing and defense skills fail during this window.'];
                } else if (command === 'gb') {
                    if (!user.loots?.includes('cursed_energy_discharge')) { await sock.sendMessage(from, { text: '⚡ *CURSED ENERGY DISCHARGE REQUIRED.* You need the CURSED ENERGY DISCHARGE loot to use .gb.', mentions: [sender] }); continue; }
                    const stats = getCombatStats(user);
                    damage = Math.max(1, Math.floor(stats.attack * 2.5) + 300);
                    techDisplayName = 'Granité Blast';
                    techEffects = ['Ryu-style maximum-output cursed energy beam — tracks, splits into homing vectors, and vaporizes reinforced defenses.'];
                    const critChance = (user._combat_crit_chance || 0.05);
                    if (Math.random() < critChance) { damage = Math.floor(damage * 1.8); isCrit = true; }
                } else if (command === 'cm') {
                    if (!user.loots?.includes('copy_mimicry')) { await sock.sendMessage(from, { text: '👁️ *COPY (MIMICRY) REQUIRED.* You need the COPY loot to use .cm.', mentions: [sender] }); continue; }
                    const list = user._copied_techniques || [];
                    if (!args[0] || args[0].toLowerCase() === 'list') {
                        if (!list.length) { await sock.sendMessage(from, { text: '📋 No techniques copied yet. Defeat enemies (not HR users) to copy their strongest technique.', mentions: [sender] }); continue; }
                        let msg = `📋 *COPIED TECHNIQUES*\n`;
                        list.forEach((c, i) => { msg += `${i + 1}. *${c.name || c._key}* (DMG ${c.damage || 0} | CE ${c.cost || 0})\n`; });
                        msg += `\nUse *.cm <number>* to unleash.`;
                        await sock.sendMessage(from, { text: msg, mentions: [sender] });
                        continue;
                    }
                    const idx = parseInt(args[0]) - 1;
                    if (idx < 0 || idx >= list.length) { await sock.sendMessage(from, { text: `📋 Invalid slot. Use .cm list to see your ${list.length} copied technique(s).`, mentions: [sender] }); continue; }
                    const copied = list[idx];
                    const fakeEnemy = { name: enemy.name, grade: enemy.grade, stats: enemy.stats, skills: enemy.skills || {} };
                    const res = applyTechniqueEffect(copied, copied._key || 'copied', user, fakeEnemy, combat);
                    damage = res.damage;
                    techDisplayName = `COPY: ${copied.name || 'Mimicked Technique'}`;
                    techEffects = [`Yuta/Rika replicate ${copied.name || 'a copied technique'} with maximum refinement.`];
                    if (Math.random() < 0.15) { damage = Math.floor(damage * 1.3); isCrit = true; }
                } else if (command === 'bw') {
                    if (!user.loots?.includes('boogie_woogie')) { await sock.sendMessage(from, { text: '👏 *BOOGIE WOOOGIE REQUIRED.* You need the BOOGIE WOOOGIE loot to use .bw.', mentions: [sender] }); continue; }
                    damage = Math.max(1, Math.floor((enemy.stats?.atk || 10) * 0.8));
                    techDisplayName = 'Boogie Woogie';
                    techEffects = ['Todo claps — coordinates swap! The enemy is hit by their own attack for ~80% of their ATK.'];
                    if (Math.random() < 0.2) { damage = Math.floor(damage * 1.5); isCrit = true; }
                } else if (command === 'csm') {
                    if (!user.loots?.includes('cursed_spirit_manipulation')) { await sock.sendMessage(from, { text: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.* You need the CURSED SPIRIT MANIPULATION loot to use .csm.', mentions: [sender] }); continue; }
                    const army = user._cursed_army || [];
                    if (!army.length) { await sock.sendMessage(from, { text: '🌀 No curses absorbed yet. Defeat cursed spirits to absorb them into your army.', mentions: [sender] }); continue; }
                    if (args[0] && args[0].toLowerCase() === 'list') {
                        let msg = `🌀 *CURSED ARMY: ${army.length} absorbed*\n───\n`;
                        army.forEach((c, i) => { msg += `${i + 1}. *${c.name}* (Grade ${c.grade})\n`; });
                        msg += `\nUse *.csm${Math.min(army.length, 9)}* to unleash a specific curse.`;
                        await sock.sendMessage(from, { text: msg, mentions: [sender] });
                        continue;
                    }
                    const csmMatch = command.match(/^csm(\d+)$/);
                    if (csmMatch) {
                        const idx = parseInt(csmMatch[1]) - 1;
                        if (idx < 0 || idx >= army.length) { await sock.sendMessage(from, { text: `🌀 Invalid slot. Use .csm list to see your ${army.length} absorbed curse(s).`, mentions: [sender] }); continue; }
                        const curse = army[idx];
                        const dmg = Math.max(1, Math.floor(120 + (enemy.grade === 0 ? 300 : enemy.grade === 1 ? 200 : 100)));
                        techDisplayName = `Maximum: ${curse.name}`;
                        techEffects = [`🌀 Released ${curse.name} (Grade ${curse.grade}) — compressed spirit strike!`];
                        user._cursed_army.splice(idx, 1);
                        damage = dmg;
                        if (Math.random() < 0.25) { damage = Math.floor(damage * 1.4); isCrit = true; }
                        continue;
                    }
                    const dmg = Math.max(1, Math.floor(army.length * 120) + 500);
                    damage = dmg;
                    techDisplayName = 'Maximum: Uzumaki';
                    techEffects = [`Condensed laser spiral from ${army.length} absorbed curse spirits — massive pierce damage.`];
                    user._cursed_army = [];
                    if (Math.random() < 0.25) { damage = Math.floor(damage * 1.4); isCrit = true; }
                } else if (command === 'csm-r') {
                    if (!user.loots?.includes('cursed_spirit_manipulation')) { await sock.sendMessage(from, { text: '🌀 *CURSED SPIRIT MANIPULATION REQUIRED.* You need the CURSED SPIRIT MANIPULATION loot to use .csm-r.', mentions: [sender] }); continue; }
                    const army = user._cursed_army || [];
                    if (!army.length) { await sock.sendMessage(from, { text: '🌀 No curses absorbed yet. Defeat cursed spirits to absorb them into your army.', mentions: [sender] }); continue; }
                    combat._cursed_army = [...army];
                    user._cursed_army = [];
                    damage = 0;
                    techDisplayName = 'Maximum: Release';
                    techEffects = [`Released ${army.length} absorbed curse spirits to defend you!`];
                } else if (command === 'it') {
                    if (!user.loots?.includes('idle_transfiguration')) { await sock.sendMessage(from, { text: '👁️ *IDLE TRANSFIGURATION REQUIRED.* You need the IDLE TRANSFIGURATION loot to use .it.', mentions: [sender] }); continue; }
                    if (enemy.loots?.includes('black_sparks')) {
                        damage = 0;
                        techDisplayName = 'Idle Transfiguration (blocked)';
                        techEffects = ['🛡️ BLACK SPARKS shields the target — Idle Transfiguration has no effect!'];
                        isDodge = true;
                    } else {
                        damage = 1800;
                        techDisplayName = 'Idle Transfiguration: Soul Shaping';
                        techEffects = ['Mahito reshapes the target\'s soul — 1800 damage, bypassing all armor/stats!'];
                        isCrit = true;
                    }
                } else if (command === 'jd') {
                    if (!user.loots?.includes('courtroom_domain')) { await sock.sendMessage(from, { text: '⚖️ *COURTROOM DOMAIN REQUIRED.* You need the COURTRDOM DOMAIN EXPANSION loot to use .jd.', mentions: [sender] }); continue; }
                    damage = 0; isDodge = true;
                    techDisplayName = 'Courtroom Domain: Deadly Sentencing';
                    const isCurse2 = enemy.grade === 0 || enemy.name?.toLowerCase().includes('curse');
                    combat._enemy_original_skills = { ...enemy.skills };
                    combat._enemy_original_technique = enemy.technique;
                    enemy.skills = {};
                    enemy.technique = null;
                    combat._judgeman_rounds = 3;
                    combat._judgeman_weak = true;
                    if (isCurse2) {
                        enemy.stats.HP = 0;
                        techEffects = ['⚖️ Judgeman: GUILTY! The curse is sentenced to death — Executioner\'s Sword strikes true!'];
                    } else {
                        techEffects = ['⚖️ Judgeman: INNOCENT! The defendant is spared. Their techniques are sealed and attacks weakened for 3 rounds.'];
                    }
                 } else if (command.startsWith('sk-')) {
                     if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ *HEAVENLY RESTRICTION:* You cannot use skills. You wield quirks — use .qk-1 or .qk-2.', mentions: [sender] }); continue; }
                     const skillNum = parseInt(command.slice(3));
                    if (isNaN(skillNum) || skillNum < 1 || skillNum > 10) { await sock.sendMessage(from, { text: 'Usage: .sk-1 through .sk-10', mentions: [sender] }); continue; }
                    const skills = db.userSkills?.[sender] || [];
                    const skillId = skills[skillNum - 1];
                    if (!skillId) { await sock.sendMessage(from, { text: `No skill equipped in slot ${skillNum}. Use .skills to view.`, mentions: [sender] }); continue; }
                    const skill = CROSS_UNIVERSE_SKILLS[skillId];
                    if (!skill) { await sock.sendMessage(from, { text: 'Skill data missing.', mentions: [sender] }); continue; }
                    if (!user.heavenly_restriction && user.stats.CE < (skill.ceCost || 0)) { await sock.sendMessage(from, { text: `⚡ Need ${skill.ceCost} CE for ${skill.name}.`, mentions: [sender] }); continue; }
                    if (!user.heavenly_restriction) user.stats.CE = Math.max(0, user.stats.CE - (skill.ceCost || 0));
                    damage = Math.max(1, skill.damage + Math.floor(Math.random() * 10));
                    techDisplayName = skill.name;
                    techEffects = [skill.desc];
                    if (Math.random() < (user._combat_crit_chance || 0.05)) { damage = Math.floor(damage * 1.5); isCrit = true; }
                    if (skill.effect === 'stun') { combat.enemyStunned = Math.max(combat.enemyStunned || 0, 1); }
                    if (skill.effect === 'immobilize') { combat.enemyStunned = Math.max(combat.enemyStunned || 0, 2); }
                    if (skill.effect === 'heal') { user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + (skill.heal || 50)); techEffects.push('💊 Healed!'); }
                    if (skill.effect === 'defend') { combat.guarding = true; techEffects.push('🛡️ Guarding!'); }
                } else if (command === 'qk-1' || command === 'qk-2') {
                    const qkIdx = parseInt(command.split('-')[1]) - 1;
                    const quirk = user.quirks?.[qkIdx];
                    if (!quirk) { await sock.sendMessage(from, { text: `🌀 No quirk equipped in slot ${qkIdx + 1}. You can hold up to 2 quirks.`, mentions: [sender] }); continue; }
                    combat.weaponOnly = false;
                    const stats = getCombatStats(user);
                    let qkDmg = Math.max(1, quirk.damage + Math.floor(Math.random() * 15));
                    if (quirk.effect === 'multi_hit') {
                        const hits = quirk.hits || 3;
                        const hitDmg = Math.max(1, Math.floor(qkDmg / hits));
                        for (let h = 0; h < hits; h++) {
                            if (enemy.stats.HP > 0) enemy.stats.HP -= hitDmg;
                        }
                        qkDmg = hitDmg * hits;
                        techEffects = [`💥 ${hits} rapid hits!`];
                    } else if (quirk.effect === 'crit_guaranteed') {
                        qkDmg = Math.floor(qkDmg * 1.5);
                        isCrit = true;
                        if (combat.enemyGuarding) { playerDmgMult = 1; combat.enemyGuarding = false; }
                        techEffects = ['🎯 Guaranteed critical hit — weak spot struck!'];
                    } else if (quirk.effect === 'armor_break') {
                        if (combat.enemyGuarding) { playerDmgMult = 1; combat.enemyGuarding = false; }
                        techEffects = ['🛡️ Armor shattered — defenses bypassed!'];
                    } else if (quirk.effect === 'pierce') {
                        if (combat.enemyGuarding) { playerDmgMult = 1; combat.enemyGuarding = false; }
                        techEffects = ['🔴 Pierces through — guard neutralized!'];
                    } else if (quirk.effect === 'pull_stun') {
                        combat.enemyStunned = Math.max(combat.enemyStunned || 0, quirk.stun || 1);
                        techEffects = ['🌪️ Vacuum sphere pulls and stuns the target!'];
                    } else if (quirk.effect === 'stun') {
                        combat.enemyStunned = Math.max(combat.enemyStunned || 0, quirk.stun || 1);
                        techEffects = ['🔊 Soundwave disrupts stance — target stunned!'];
                    } else if (quirk.effect === 'defend') {
                        combat.guarding = true;
                        techEffects = ['🛡️ Density hardened — guarding next attack!'];
                    } else if (quirk.effect === 'reflect_setup') {
                        combat._reflectNext = true;
                        techEffects = ['🪞 Barrier deployed — next projectile will be reflected!'];
                    }
                    if (quirk.effect === 'burn') {
                        combat.enemyStatus = combat.enemyStatus || [];
                        combat.enemyStatus.push({ name: 'BURN', turns: quirk.turns || 3, dot: quirk.dot || 30 });
                        techEffects.push(`🔥 Burn applied: ${quirk.dot || 30} DMG/turn for ${quirk.turns || 3} turns!`);
                    }
                    if (quirk.effect === 'dot_scaling') {
                        combat.enemyStatus = combat.enemyStatus || [];
                        let dotVal = quirk.dot || 20;
                        combat.enemyStatus.push({ name: 'DECAY', turns: quirk.turns || 5, dot: dotVal, scaling: true, baseDot: dotVal });
                        techEffects.push(`☠️ Decay applied: starts at ${dotVal} DMG/turn and scales up!`);
                    }
                    damage = qkDmg;
                    techDisplayName = quirk.name;
                    if (Math.random() < (user._combat_crit_chance || 0.05)) { damage = Math.floor(damage * 1.5); isCrit = true; }
                    if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                } else {
                    combat.weaponOnly = false;
                    const tnum = command.match(/([1-5])$/);
                    if (tnum && tnum[1] === '5') {
                        if (!user.custom_technique) { await sock.sendMessage(from, { text: '⚡ No RCT technique forged yet. Unlock one with `.t5r` (requires RCT).'  , mentions: [sender] }); continue; }
                        move = user.custom_technique;
                        techKey = 'custom_t5r';
                        if (args.length > 0) {
                            move = { ...move, env: args.join(' ') };
                            techEffects = techEffects || [];
                            techEffects.push(`🌍 Environment: ${args.join(' ')}`);
                        }
                    } else {
                        techKey = tnum ? user['technique_' + tnum[1]] : null;
                        move = INNATE_TECHNIQUES[user.innate_technique_id]?.moves?.[techKey];
                    }
                     if (!move) { await sock.sendMessage(from, { text: 'Technique not found.'  , mentions: [sender] }); continue; }
                     // V2 Combat Cooldowns
                     const cooldownKey = `tech_${techKey}`;
                     if (isOnCooldown(user, cooldownKey)) {
                         const remaining = Math.ceil(getCooldownRemaining(user, cooldownKey) / 1000);
                         await sock.sendMessage(from, { text: `⏳ *COOLDOWN:* ${techDisplayName || techKey} is on cooldown for ${remaining}s.`, mentions: [sender] });
                         continue;
                     }
                     // Techniques channel a meaningful chunk of cursed energy (min 20 CE).
                     let ceCost = Math.max(20, move.cost || 0);
                     // Efficiency: reduce technique CE cost.
                     if (user._skills?.ce_reduction) ceCost = Math.max(1, Math.floor(ceCost * (1 - user._skills.ce_reduction)));
                     const armorCeReduction = getArmorEffect(user, 'ce_reduction') || 0;
                     if (armorCeReduction) ceCost = Math.max(1, Math.floor(ceCost * (1 - armorCeReduction)));
                      // LIMITLESS & SIX-EYES grants unlimited cursed energy — techniques are free.
          const limitless = user.loots?.includes('limitless_six_eyes') || !!getArmorEffect(user, 'six_eyes_vestments');
         const isHR2 = !!user.heavenly_restriction;
                     if (!limitless && !isHR2 && user.stats.CE < ceCost) { await sock.sendMessage(from, { text: `[⚠️ INSUFFICIENT ENERGY MATRICES: ACTION FORFEITED]\nRequires ${ceCost} CE — you have ${user.stats.CE}.`  , mentions: [sender] }); continue; }
                     if (!limitless && !isHR2) user.stats.CE = Math.max(0, user.stats.CE - ceCost);
                     else if (limitless) user.stats.CE = user.stats.Max_CE;
                     move = { ...move, cost: ceCost };
                     // V2 Cooldowns: apply a short cooldown for high-cost techniques
                     const cooldownMs = Math.max(1000, Math.floor(ceCost * 80));
                     setCooldown(user, `tech_${techKey}`, cooldownMs);
                     if (techKey === 'super_fast_slash') {
                        user._temp_speed_buff = 1.45;
                        const heavyMove = INNATE_TECHNIQUES[user.innate_technique_id]?.moves?.heavy_slash;
                        if (heavyMove) move = { ...heavyMove, cost: ceCost };
                        techDisplayName = 'Super Fast Slash';
                        techEffects = ['⚡ Speed increased by 45%! Unleashing Heavy Slash!'];
                    } else if (techKey === 'divine_axe_slash') {
                        if (user.stats.HP > 10) {
                            await sock.sendMessage(from, { text: '⚔️ Divine Axe Slash requires 10 HP or less to unleash!', mentions: [sender] });
                            continue;
                        }
                        move = { ...move, damage: 500 };
                        techDisplayName = 'Divine Axe Slash';
                        techEffects = ['🪓 Divine axe descends — 500 damage!'];
                    }
                    techDisplayName = move.name || getTechDisplayName(techKey);
                    const techResult = applyTechniqueEffect(move, techKey, user, enemy, combat);
                    damage = techResult.damage;
                    techEffects = techResult.narration;
                    const techBonus = user._combat_tech_bonus || 0;
                    if (techBonus > 0) damage = Math.floor(damage * (1 + techBonus));
                    // Reality Slash: amplify technique damage further (stacks with Amplify).
                    if (user._skills?.max_technique) damage = Math.floor(damage * (1 + user._skills.max_technique));
                    let critChance = (user._combat_crit_chance || 0.05) * (combatHasStatus(combat, 'BLIND') ? 0.5 : 1);
                    // Mastery: extra technique crit chance.
                    if (user._skills?.technique_crit) critChance += user._skills.technique_crit;
                    if (Math.random() < critChance) { damage = Math.floor(damage * 1.5); isCrit = true; }
                    if (Math.random() < 0.08) { isDodge = true; damage = 0; }
                    if (combat.counter_state && Math.random() < 0.3) { damage = Math.floor(damage * 1.8); isCounter = true; combat.counter_state = false; }
                    if (user.stats.HP < 10 && user.stats.CE > 20 && Date.now() > (user.combo_god_until || 0) && Math.random() < 0.05) {
                        user.combo_god_until = Date.now() + 30000;
                        user.title = 'Combo God';
                    }
                    if (Date.now() < (user.combo_god_until || 0)) damage *= 4000;
                }
                 damage = Math.floor(damage * playerDmgMult * combatDamageMult(combat));
                 // V2 Combo Chain
                 const now = Date.now();
                 const combo = incrementComboChain(combat, now);
                 if (combo.count >= 2) {
                     const comboMult = combo.multiplier;
                     damage = Math.floor(damage * comboMult);
                     if (combo.count === 2) techEffects.push('⚡ Combo x2!');
                     else if (combo.count === 5) techEffects.push('🔥 Combo x5!');
                     else if (combo.count === 10) techEffects.push('💥 COMBO x10!!');
                 }
                 // V2 Technique Mastery: grant XP on successful hit
                 if (damage > 0 && techKey && user.technique_mastery) {
                     const mastery = getTechniqueMastery(user, techKey);
                     addTechniqueMasteryXp(user, techKey, Math.ceil(damage / 10));
                     recordTechniqueDamage(user, techKey, damage);
                     if (isCrit) recordCriticalHit(user);
                 }
                 // V2 Weapon Mastery: grant XP on weapon strike
                 if (damage > 0 && command === 'wa' && user.weapon?.id) {
                     const wMastery = getWeaponMastery(user, user.weapon.id);
                     addWeaponMasteryXp(user, user.weapon.id, Math.ceil(damage / 5));
                     const wBonus = getWeaponMasteryDamageBonus(user, user.weapon.id);
                     if (wBonus > 0) damage = Math.floor(damage * (1 + wBonus));
                 }
                 // Executioner: bonus damage to enemies below 20% HP.
                if (user._skills?.execute_damage && enemy.stats.HP < enemy.stats.Max_HP * 0.2) {
                    damage = Math.floor(damage * (1 + user._skills.execute_damage));
                }
                // God of War: bonus damage while on a win streak.
                if (user._skills?.combo_damage && (user.consecutive_wins || 0) > 0) {
                    damage = Math.floor(damage * (1 + user._skills.combo_damage));
                }
                 if (damage > 0) enemy.stats.HP -= damage;
                 const summonResult = executeSummonPhase(user, enemy);
                 if (summonResult.summonDamage > 0) enemy.stats.HP -= summonResult.summonDamage;
                 const enemyDotLines = tickEnemyStatus(combat, enemy);
                 if (combat.tagTeamActive && combat.npcAlly && combat.npcAlly.hp > 0) {
                     const npcDmg = Math.max(1, combat.npcAlly.atk + Math.floor(Math.random() * 12));
                     enemy.stats.HP -= npcDmg;
                     combat.npcAlly.hp = Math.max(0, combat.npcAlly.hp - Math.max(1, Math.floor(enemy.atk * 0.3)));
                 }
                 if (combat._cursed_army && combat._cursed_army.length > 0) {
                     const curseArmyDmg = Math.max(1, Math.floor(combat._cursed_army.length * 80));
                     enemy.stats.HP -= curseArmyDmg;
                     techEffects.push(`🌀 ${combat._cursed_army.length} released curses strike for ${curseArmyDmg} damage!`);
                 }

                if (enemy.stats.HP <= 0) {
                    recordCurseDefeat(user, enemy);
                    // Co-op: every participant shares the victory loot.
                    const participants = (combat.participants || [sender]).map(j => db.users[j]).filter(Boolean);
                    // Curse XP is tuned so ~4 kills at a given grade push the player up one level.
                    const rewardXp = Math.ceil((user.xp_needed || 31000) / 4);
                    const rewardGold = 80 + (enemy.grade || 0) * 30;
                    for (const p of participants) {
                        p.consecutive_wins = (p.consecutive_wins || 0) + 1;
                        p.xp += rewardXp;
                        p.wallet += rewardGold;
                        if (db.cullingGame?.active && db.cullingGame.players[p.player_id]) {
                            const cgp = p.cullingGame || {};
                            cgp.points = (cgp.points || 0) + 10;
                            cgp.lastPointChange = Date.now();
                        }
                    }
                     // HEAVENLY RESTRICTION: defeat a Special Grade curse using ONLY weapon (.wa) strikes.
                     let hrMsg = '';
                     if (combat.weaponOnly === true && (enemy.grade ?? 4) === 0) {
                         if (grantHeavenlyRestriction(user)) {
                             const quirkNames = (user.quirks || []).map(q => q.name).join(', ');
                             hrMsg = `\n⛓️ *HEAVENLY RESTRICTION AWAKENED!* Your cursed technique is severed — your body is now the weapon. .wa strike = 200, .attack = 150.\n🌀 Quirks: ${quirkNames}`;
                         }
                     }
                     // Kenjaku defeat: special rewards
                     let kenjakuMsg = '';
                     if (enemy.name === 'Kenjaku') {
                         user.wallet = (user.wallet || 0) + 50000000;
                         user.xp = (user.xp || 0) + 2000000;
                         checkLevelUp(user);
                         kenjakuMsg = `\n👑 *KENJAKU DEFEATED!*\nYou have conquered the mastermind of the Culling Game!\nRewards: +50,000,000 K-Coins, +2,000,000 XP`;
                         broadcastAllGroups(sock, `👑 *KENJAKU HAS BEEN DEFEATED!*\n${user.name || sender} has conquered the mastermind of the Culling Game!\nThe barrier shatters and peace returns to the colonies.`);
                     }
                     endCombatKeys(combat);
                     saveDb();
                    if (!db._firstBloodWinner && db._bootTime && user.registered && (Date.now() - db._bootTime < 10 * 60 * 1000)) {
                        db._firstBloodWinner = sender;
                        const granted = grantLoot(user, 'courtroom_domain', true);
                        if (granted) {
                            saveDb();
                            await sock.sendMessage(from, { text: `🏆 *FIRST BLOOD!*\nYou were the first registered user to defeat a curse within the first 10 minutes!\nYou received *${granted.name}*!`, mentions: [sender] });
                        }
                    }
                    const fingerKey = tryGrantFinger(user, enemy.name);
                    let fingerMsg = '';
                    if (fingerKey !== null) {
                        fingerMsg = `\n🔥 *SUKUNA FINGER OBTAINED!* (${db.sukunaFingers.remaining} remaining)`;
                        if ((user.fingers || []).length >= 20 && !db.sukuna?.active) {
                            spawnSukuna(sock, sender, user.name || sender.split('@')[0]);
                            fingerMsg += `\n⚠️ *ALL 20 FINGERS GATHERED — SUKUNA AWAKENS!*`;
                        }
                    }
                    if (Math.random() < 0.3) {
                        const equipNames = Object.keys(EQUIPMENT_DB);
                        const drop = generateEquipment(pick(equipNames), 'common');
                        if (drop) user.inventory.push(drop);
                    }
                    // Loot drop. LIMITLESS & SIX-EYES is a 2% overall chance; any other
                    // unique loot from the global pool drops at 30% (only one of each exists).
                    let lootMsg = '';
                    initLootPool();
                    if (db.lootPool.limitless_six_eyes && Math.random() < 0.02) {
                        const l = grantLoot(user, 'limitless_six_eyes', true);
                        lootMsg = `\n🎁 *UNIQUE LOOT:* ${l.name} — ${l.desc}`;
                    } else if (Math.random() < 0.30) {
                        const avail = availableLootIds().filter(id => id !== 'limitless_six_eyes');
                        if (avail.length) {
                            const l = grantLoot(user, pickWeightedLoot(avail), true);
                            lootMsg = `\n🎁 *UNIQUE LOOT:* ${l.name} — ${l.desc}`;
                        }
                    }
                    const newAchs = checkAchievements(user);
                    if (combat.tagTeamActive && !user.achievements.includes('besto_friendo')) {
                        user.achievements.push('besto_friendo');
                        newAchs.push('Besto Friendo');
                    }
                    const leveledLines = [];
                    for (const p of participants) { if (checkLevelUp(p)) leveledLines.push(`${p.name || p.player_id} (Lv ${p.level})`); }
                    if (leveledLines.length) { await sock.sendMessage(from, { text: `⬆️ LEVEL UP! ${leveledLines.join(', ')}!`  , mentions: participants.map(p => p.player_id) }); }
                    if (newAchs.length) { await sock.sendMessage(from, { text: `🏆 ACHIEVEMENTS: ${newAchs.join(', ')}`   , mentions: [sender] }); }
                    const dropMsg = user.inventory.length ? `\nLoot: ${user.inventory[user.inventory.length - 1].rarityColor} ${user.inventory[user.inventory.length - 1].name}` : '';
                    const victoryText = `💥 VICTORY!\nDealt ${damage} damage.${isCrit ? ' CRITICAL!' : ''}${isCounter ? ' COUNTER!' : ''}\nReward: +${fmtNum(rewardXp)} XP, +${fmtNum(rewardGold)} Gold${dropMsg}${lootMsg}`;
                    const winnerName = user.name || sender.split('@')[0];
                    const shareLine = participants.length > 1 ? `\n🤝 CO-OP VICTORY! Loot shared with: ${participants.map(p => p.name || p.player_id).join(', ')}` : '';
                     const victoryCaption = `💥 *VICTORY!* ${winnerName} defeated ${enemy.name}!\n🗡️ Finishing blow: ${damage} damage${isCrit ? ' (CRITICAL!)' : ''}${isCounter ? ' (COUNTER!)' : ''}\n🎁 Reward: +${fmtNum(rewardXp)} XP, +${fmtNum(rewardGold)} Gold${dropMsg}${lootMsg}${fingerMsg}${hrMsg}${kenjakuMsg}${shareLine}`;
                    await sock.sendMessage(from, { text: victoryCaption, mentions: participants.map(p => p.player_id) }); continue;
                }

                if (enemy.stats.HP < enemy.originalMaxHP * 0.25 && Math.random() <= (user.combat_state?.enemy_flee_chance || 0.20)) {
                    user.stalker_curse = { name: `[Vengeful ${enemy.name}]`, grade: enemy.grade, skills: enemy.skills, stats: { HP: enemy.originalMaxHP * 2, Max_HP: enemy.originalMaxHP * 2, CE: 100 }, outputBuff: 0.5 };
                    endCombatKeys(combat);
                    saveDb();
                    await sock.sendMessage(from, { text: `💨 [TACTICAL ANNIHILATION EVASION: THE TARGET ESCAPED!]\nThe spirit dissolved into ambient negative energy.\n───\n*Status: [EVOLVING AMBUSH]*`   , mentions: [sender] }); continue;
                }

                const phase = runEnemyPhase(combat, user);
                if (phase.dead) {
                    if (!user.unlocked_features.RCT && Math.random() <= 0.05) { user.unlocked_features.RCT = true; user.stats.HP = 1; saveDb(); await sock.sendMessage(from, { text: '⚡ RCT UNLOCKED!'   , mentions: [sender] }); }
                    else {
                        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                        if (r === 'ended' || r === 'knocked') continue;
                    }
                }

                combat.round++;
                combat.counter_state = false;
                combat.enemyIntent = pickEnemyMove();
                saveDb();
                if (combat.playerDomainBurnout > 0) combat.playerDomainBurnout--;
                const playerDesc = getCinematicPlayerDescription('attack' === command ? 'attack' : 'technique', techKey, damage, isCrit);
                const heroName = user.name || sender.split('@')[0];
                let log = `${formatUI(user, enemy, combat.round, combat.location || user.current_node)}\n\n`;
                if (bleedLines.length) log += `🩸 Bleeding: ${bleedLines.join(', ')}\n\n`;
                log += `🧑‍🎓 ${heroName}: ${techDisplayName ? `unleashed *${techDisplayName}*! ` : ''}${playerDesc}\n`;
                if (techEffects.length) log += `✨ EFFECT: ${techEffects.join(' | ')}\n`;
                log += `💥 OUTPUT: -${damage} DMG applied to ${enemy.name}!${isCrit ? ' (CRITICAL!)' : ''}${isCounter ? ' (COUNTER!)' : ''}\n`;
                if (enemyDotLines.length) log += `☣️ AFFLICTION: ${enemyDotLines.join(', ')}\n`;
                log += `\n`;
                if (summonResult.log) log += `${summonResult.log}\n\n`;
                log += `👹 RETRIBUTION: ${phase.enemyDesc}\n`;
                if (phase.stunned) log += `⭐ ${enemy.name} is stunned and loses its turn!\n`;
                else if (phase.eDamage > 0) log += `☠️ IMPACT: -${phase.eDamage} DMG sustained by ${heroName}!${phase.guarded ? ' (GUARDED! -60%)' : ''}\n`;
                else log += `☠️ IMPACT: 0 DMG sustained (DODGED!)\n`;
                const statusStr = combatStatusSummary(combat);
                if (statusStr) log += `🔮 STATUS: ${statusStr}\n`;
                log += `\n🗣️ NARRATOR: Round ${combat.round} — ${heroName} ${isDodge ? `whiffs the strike as ${enemy.name} slips away` : (damage > 0 ? `${techDisplayName ? `channels ${techDisplayName} into ${enemy.name} for ${damage}${isCrit ? ' CRITICAL' : ''} damage` : `strikes ${enemy.name} for ${damage}${isCrit ? ' CRITICAL' : ''} damage`}` : `fails to wound ${enemy.name}`)}${techEffects.length ? ` and ${techEffects[0]}` : ''}. ${phase.stunned ? `${enemy.name} is incapacitated and cannot retaliate!` : (phase.eDamage > 0 ? `${enemy.name} retaliates for ${phase.eDamage} damage` : `${heroName} reads the counter and evades`)}.\n`;
                log += `👁️ ENEMY INTENT: ${enemyIntentHint(combat.enemyIntent)}\n`;
                log += `──────────────────────────────────────────\n`;
                log += `📊 SYSTEM DELTA: CE: ${move ? '-' + move.cost : '0'} | Enemy HP: -${damage} | Player HP: ${phase.eDamage > 0 ? '-' + phase.eDamage : '0'}\n`;
                log += `╚════════════════════════════════════════╝\n`;
                log += `*Action Paths:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .guard | .flee`;
                const battleText = buildCombatText({
                    combat,
                    user,
                    enemy,
                    heroName,
                    damage,
                    techDisplayName,
                    techEffects,
                    phase,
                    isCrit,
                    isDodge,
                    enemyDotLines,
                    summonResult,
                    location: combat.location || user.current_node
                });
                await sock.sendMessage(from, { text: battleText, mentions: [sender] });
            }

            else if (command === 'guard') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await handleRaidTurn(sock, from, sender, user, command); continue; }
                const combat = db.combats[sender];
                if (!combat) { await sock.sendMessage(from, { text: 'No combat.'  , mentions: [sender] }); continue; }
                const { enemy } = combat;
                const bleedLines = tickCombatStatus(combat, user);
                if (user.stats.HP <= 0) {
                    const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                    if (r === 'ended' || r === 'knocked') continue;
                }
                user.stats.CE = Math.min(user.stats.Max_CE, user.stats.CE + 15);
                combat.guarding = true;
                const phase = runEnemyPhase(combat, user);
                if (phase.dead) {
                    if (!user.unlocked_features.RCT && Math.random() <= 0.05) { user.unlocked_features.RCT = true; user.stats.HP = 1; saveDb(); await sock.sendMessage(from, { text: '⚡ RCT UNLOCKED!'   , mentions: [sender] }); }
                    else {
                        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                        if (r === 'ended' || r === 'knocked') continue;
                    }
                }
                combat.round++;
                combat.counter_state = false;
                combat.enemyIntent = pickEnemyMove();
                saveDb();
                let log = `${formatUI(user, enemy, combat.round, combat.location || user.current_node)}\n\n`;
                if (bleedLines.length) log += `🩸 Bleeding: ${bleedLines.join(', ')}\n\n`;
                log += `🧑‍🎓 PLAYER: Braced behind a Cursed Guard, CE restored +15.\n`;
                log += `💥 OUTPUT: 0 DMG (defending)\n\n`;
                log += `👹 RETRIBUTION: ${phase.enemyDesc}\n`;
                if (phase.eDamage > 0) log += `☠️ IMPACT: -${phase.eDamage} DMG sustained${phase.guarded ? ' (GUARDED! -60%)' : ''}!\n`;
                else log += `☠️ IMPACT: 0 DMG sustained (DODGED!)\n`;
                const statusStr = combatStatusSummary(combat);
                if (statusStr) log += `🔮 STATUS: ${statusStr}\n`;
                log += `\n🗣️ NARRATOR: Round ${combat.round}. You hold your ground, the threat ${phase.eDamage > 0 ? `lands ${phase.eDamage} damage` : 'misses'}.\n`;
                log += `👁️ ENEMY INTENT: ${enemyIntentHint(combat.enemyIntent)}\n`;
                log += `──────────────────────────────────────────\n`;
                log += `📊 SYSTEM DELTA: CE: +15 | Enemy HP: 0 | Player HP: ${phase.eDamage > 0 ? '-' + phase.eDamage : '0'}\n`;
                log += `╚════════════════════════════════════════╝\n`;
                log += `*Action Paths:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .guard | .flee`;
                const guardName = user.name || sender.split('@')[0];
                const guardText = buildCombatText({
                    combat,
                    user,
                    enemy,
                    heroName: guardName,
                    damage: 0,
                    techDisplayName: 'Cursed Guard',
                    techEffects: ['+15 CE restored'],
                    phase,
                    isCrit: false,
                    isDodge: false,
                    enemyDotLines: [],
                    summonResult: { log: '' },
                    location: combat.location || user.current_node
                });
                await sock.sendMessage(from, { text: guardText, mentions: [sender] });
            }

             else if (command === 'flee') {
                 if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '*YOU CANNOT FLEE THE SUKUNA RAID. DEATH IS THE ONLY EXIT.*', mentions: [sender] }); continue; }
                 if (!combat) { await sock.sendMessage(from, { text: 'Not in combat.'  , mentions: [sender] }); continue; }
                 if (!user) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                 const fleeChance = 0.80 + (getArmorEffect(user, 'flee_boost') || 0);
                 if (Math.random() > fleeChance) {
                     await sock.sendMessage(from, { text: '🏃 *FLEE FAILED!* The enemy blocks your escape!', mentions: [sender] });
                     combat.round++;
                     combat.enemyIntent = pickEnemyMove();
                     saveDb();
                     continue;
                 }
                 user.title = 'Loser';
                 user.loser_until = Date.now() + 72 * 60 * 60 * 1000;
                 if (sender === combat.host) {
                     endCombatKeys(combat);
                     saveDb();
                     await sock.sendMessage(from, { text: `🏃 *FLEE SUCCESSFUL*\n───\nTitle acquired: *Loser* (72h)\nThe co-op battle scatters — all fighters disengage.\nQuest terminated.`   , mentions: [sender] });
                 } else {
                     combat.participants = (combat.participants || []).filter(j => j !== sender);
                     if (db.combats[sender] === combat) delete db.combats[sender];
                     saveDb();
                     await sock.sendMessage(from, { text: `🏃 *FLEE SUCCESSFUL*\n───\nTitle acquired: *Loser* (72h)\nYou withdrew from the co-op battle; your allies carry on.`   , mentions: [sender] });
                 }
             }

              else if (command === 'heal') {
                  if (!user) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  const fishCount = (user.inventory || []).filter(i => i.name === 'Fish').length;
                  const summonNeedsHeal = user.summon?.active && user.summon.HP < user.summon.Max_HP;
                  const fishNeeded = summonNeedsHeal ? 2 : 1;
                  if (fishCount < fishNeeded) {
                      const msg = summonNeedsHeal
                          ? `🐟 *NEED 2 FISH!* You have ${fishCount} fish. Your summon also needs healing — `.heal` costs 2 fish.`
                          : `🐟 *NO FISH!* You need a Fish in your inventory to heal. Use .fish to catch one.`;
                      await sock.sendMessage(from, { text: msg, mentions: [sender] }); continue;
                  }
                  if (getPvpMatch(from, sender)) { await sock.sendMessage(from, { text: '💊 *HEAL LOCKED:* You cannot heal during a PvP duel. Use .rct for emergency CE-to-HP conversion.', mentions: [sender] }); continue; }
                  if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '💊 *HEAL LOCKED:* You cannot heal during the Sukuna raid. Use .rct for emergency CE-to-HP conversion.', mentions: [sender] }); continue; }
                  if (Date.now() < (user._vow_until || 0)) { await sock.sendMessage(from, { text: '🔮 *VOW OF RUIN:* You sacrificed healing — .heal is disabled.', mentions: [sender] }); continue; }
                  const now = Date.now();
                  const last = user.last_heal || 0;
                  const cooldown = 60 * 1000;
                  if (now - last < cooldown) {
                      const remaining = Math.ceil((cooldown - (now - last)) / 1000);
                      await sock.sendMessage(from, { text: `💊 *HEAL COOLDOWN*\nWait ${remaining}s.`   , mentions: [sender] }); continue;
                  }
                  user.last_heal = now;
                  user.inventory = (user.inventory || []).filter(i => i.name !== 'Fish');
                  user.stats.HP = user.stats.Max_HP;
                  user.stats.CE = user.stats.Max_CE;
                  if (summonNeedsHeal && user.summon) {
                      user.summon.HP = user.summon.Max_HP;
                  }
                  clearDoTStatuses(user, combat);
                  saveDb();
                  const healMsg = summonNeedsHeal
                      ? `🐟 *ATE 2 FISH & HEALED*\n${user.name || sender.split('@')[0]} restored to *${user.stats.Max_HP} HP* | *${user.stats.Max_CE} CE*.\n🐾 Summon also fully healed!`
                      : `🐟 *ATE FISH & HEALED*\n${user.name || sender.split('@')[0]} restored to *${user.stats.Max_HP} HP* | *${user.stats.Max_CE} CE*.`;
                  await sock.sendMessage(from, { text: healMsg, mentions: [sender] });
              }

             else if (command === 'accept-s') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                 if (!db.sukuna?.active) { await sock.sendMessage(from, { text: '*SUKUNA IS NOT ACTIVE.*', mentions: [sender] }); continue; }
                 const raid = db.sukuna;
                 if (raid.players[sender]) { await sock.sendMessage(from, { text: '*YOU ARE ALREADY IN THE SUKUNA RAID.*', mentions: [sender] }); continue; }
                 if (Object.keys(raid.players).length >= MAX_RAID_PLAYERS) { await sock.sendMessage(from, { text: `*RAID IS FULL (MAX ${MAX_RAID_PLAYERS} FIGHTERS).*`, mentions: [sender] }); continue; }
                 user.stats.HP = user.stats.Max_HP;
                 user.stats.CE = user.stats.Max_CE;
                 const name = user.name || sender.split('@')[0];
                 raid.players[sender] = { name, hp: user.stats.Max_HP, maxHp: user.stats.Max_HP, jid: sender, guarding: false };
                 raid.participants = raid.participants || {};
                 raid.participants[sender] = name;
                 saveDb();
                 const sukunaName = raid._is15Finger ? '15-FINGER SUKUNA' : 'RYOMEN SUKUNA';
                 const sukunaHp = raid.hp || raid.maxHp;
                 await sock.sendMessage(from, { text: `☠️ *YOU HAVE ENTERED THE ${sukunaName} RAID*\nYou cannot flee. Death is the only exit.\nAttack: .attack | .technique-1..4 | Defend: .guard\nFighters: ${Object.keys(raid.players).length}/${MAX_RAID_PLAYERS}\n${sukunaName}: ${sukunaHp}/${raid.maxHp} HP`, mentions: [sender] });
                broadcastAllGroups(sock, `*${name.toUpperCase()} HAS ENTERED THE SUKUNA RAID!*\nFIGHTERS ON THE FIELD: ${Object.keys(raid.players).length}/${MAX_RAID_PLAYERS}\nTYPE .accept-s TO JOIN THE BATTLE AGAINST THE STRONGEST CURSE.`);
            }

             else if (command === 'sukuna') {
                 if (db.sukuna?.active) {
                     const r = db.sukuna;
                     const name = r._is15Finger ? '15-FINGER SUKUNA' : 'RYOMEN SUKUNA';
                     const title = r._is15Finger ? 'THE KING OF CURSES — FULL POWER' : 'THE STRONGEST CURSE IN HISTORY';
                     await sock.sendMessage(from, { text: `👹 *${name}* — ${title}\nHP: ${r.hp}/${r.maxHp}\nFighters: ${Object.keys(r.players).length}/${MAX_RAID_PLAYERS}\nUse .accept-s to join the raid. You cannot flee.`, mentions: [sender] });
                 } else {
                     const rem = db.sukunaFingers ? db.sukunaFingers.remaining : 20;
                     const scat = db.scatteredFingers || 0;
                     let msg = `🔥 *SUKUNA FINGERS:*\n• Remaining in curses: ${rem}/20\n• Scattered: ${scat}/20\n`;
                     if (db.cullingGame?.strongestSealed && db.cullingGame.strongestJid) {
                         const strongest = db.users[db.cullingGame.strongestJid];
                         const fingerCount = (strongest?.fingers || []).length;
                         msg += `\n👁️ *KENJAKU EVENT ACTIVE*\nThe strongest player (${strongest?.name || 'Unknown'}) has been sealed in Prison Realm.\n${fingerCount}/15 fingers have converged on them.\nWhen they are freed, 15-Finger Sukuna will awaken!`;
                     }
                     msg += `\nUse .search to hunt scattered fingers, or defeat curses. Gather all 20 (yours or given via .sf-give) to awaken Sukuna.`;
                     await sock.sendMessage(from, { text: msg, mentions: [sender] });
                 }
             }

            else if (command === 'search') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                const rem = db.sukunaFingers ? db.sukunaFingers.remaining : 20;
                const statusLine = `🔥 *SUKUNA FINGERS —* Remaining: ${rem}/20`;
                const hv = fingerHoldersView();
                let msg = `${statusLine}\n\n`;
                if (db.darkContinent?.active) {
                    const shards = db.darkContinent.shards || [];
                    msg += `🌑 *DARK CONTINENT FINGERS*\n`;
                    if (shards.length === 0) msg += `All fingers have been found!\n`;
                    else msg += `Scattered across ${shards.length} unknown region(s). Use .explore <region> to hunt them.\n`;
                }
                msg += `\n${hv.line}`;
                await sock.sendMessage(from, { text: msg, mentions: hv.mentions.length ? hv.mentions : [sender] });
            }

             else if (command === 'dmap') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 ensureDarkContinent();
                 try {
                     const canvas = drawDarkContinentMap();
                     const buf = canvas.toBuffer('image/png');
                     const shards = db.darkContinent.shards || [];
                     
                     // Fog of War: randomly hide some region data
                     const regionCount = Object.keys(db.darkContinent.regions || {}).length;
                     const exploredCount = Object.values(db.darkContinent.regions || {}).filter(r => r.explored).length;
                     const fogChance = user.sanity < 40 ? 0.5 : 0.2; // Higher fog chance with low sanity
                     const showShards = Math.random() > fogChance;
                     
                     let caption = `🌑 *THE DARK CONTINENT*\n`;
                     if (user.sanity < 40) {
                         caption += `⚠️ *SANITY LOW (${user.sanity}%):* Map coordinates are scrambled!\n`;
                     }
                     caption += `Regions: ${regionCount} | Explored: ${exploredCount}\n`;
                     if (showShards) {
                         caption += `Pandora Shards: ${shards.length}/4\n`;
                     } else {
                         caption += `Pandora Shards: ???\n`;
                     }
                     caption += `Use .explore <region name> to enter.`;
                     
                     await sock.sendMessage(from, { image: buf, caption, mentions: [sender] });
                 } catch (e) {
                     await sock.sendMessage(from, { text: '🌑 *THE DARK CONTINENT*\nMap generation failed. Use .explore <region> to enter manually.', mentions: [sender] });
                 }
             }

             else if (command === 'explore' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 if (combat) { await sock.sendMessage(from, { text: 'Already in combat.', mentions: [sender] }); continue; }
                 ensureDarkContinent();
                 const regionName = args.join(' ').toLowerCase();
                 const region = Object.values(db.darkContinent.regions).find(r => r.name.toLowerCase().includes(regionName));
                 if (!region) { await sock.sendMessage(from, { text: '🌑 Region not found. Use .dmap to see available regions.', mentions: [sender] }); continue; }
                  if (region.explored && !jidInArray(sender, region.exploredBy)) {
                      let logText = `📖 *LOGBOOK: ${region.name}*\n`;
                      region.logbook.slice(-10).forEach(entry => { logText += `\n> ${entry}`; });
                      await sock.sendMessage(from, { text: logText || `📖 *LOGBOOK: ${region.name}*\nNo entries yet.`, mentions: [sender] });
                      continue;
                  }
                   region.explored = true;
                   addJidToArray(sender, region.exploredBy);
                  generateRegionCurses(region.id);
                  generateRegionTreasure(region.id);
                  
                  // Generate sub-regions on first exploration
                  const subRegions = generateSubRegions(region.id);
                  
                  const shard = db.darkContinent.shards?.includes(region.id);
                  let msg = `🌑 *ENTERED: ${region.name}*\n───\n`;
                  msg += `Level: ${region.level}+ | Danger: ${'⚠️'.repeat(region.danger)}\n`;
                  msg += `Curses detected: ${region.curses.length}\n`;
                  if (shard) msg += `\n🔮 You sense a *Pandora Shard* resonating nearby...\n`;
                  
                  // Environmental hazard
                  if (region.environmental) {
                      const env = region.environmental;
                      msg += `\n⚠️ *ENVIRONMENTAL HAZARD: ${env.name}*\n${env.desc}\n`;
                      
                      // Apply immediate effects
                      if (env.effect === 'decay') {
                          const hpDrain = Math.floor(user.stats.Max_HP * env.hpDrain);
                          const ceDrain = Math.floor(user.stats.Max_CE * env.ceDrain);
                          user.stats.HP = Math.max(1, user.stats.HP - hpDrain);
                          user.stats.CE = Math.max(0, user.stats.CE - ceDrain);
                          msg += `💀 Miasma drains ${hpDrain} HP and ${ceDrain} CE!\n`;
                      } else if (env.effect === 'sanity_drain') {
                          user.sanity = Math.max(0, (user.sanity || 100) - (env.sanityDrain || 5));
                          msg += `🧠 Sanity drops to ${user.sanity}%\n`;
                      }
                  }
                  
                   // Sub-regions
                   if (subRegions.length) {
                       msg += `\n🕳️ *SUB-REGIONS (${subRegions.length})*\n───\n`;
                       subRegions.forEach((sub, i) => {
                           msg += `${i + 1}. *${sub.name}* | Lvl: ${sub.level}+ | Danger: ${'⚠️'.repeat(sub.danger)} | Curses: ${sub.curses.length}\n`;
                           if (sub.environmental) msg += `   ⚠️ ${sub.environmental.name}\n`;
                       });
                       msg += `\nUse .sub <name> to enter a sub-region.`;
                   }
                  
                  msg += `\n📖 *LOGBOOK UPDATED*\n`;
                  region.logbook.push(`${new Date().toLocaleTimeString()} — ${user.name || sender.split('@')[0]} entered the region.`);
                  const treasure = discoverTreasure(region.id, sender);
                  if (treasure) {
                      msg += `\n🎁 *TREASURE DISCOVERED:* ${treasure.name}\n${treasure.desc}\n`;
                  }
                  saveDb();
                  await sock.sendMessage(from, { text: msg, mentions: [sender] });
              }

              else if (command === 'engage-r') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                  ensureDarkContinent();
                  
                  // Check if user is in a sub-region first
                   let currentRegion = Object.values(db.darkContinent.regions).find(r => jidInArray(sender, r.exploredBy));
                   let currentSubRegion = null;
                   if (currentRegion?.subRegions) {
                       currentSubRegion = currentRegion.subRegions.find(sr => jidInArray(sender, sr.exploredBy));
                   }
                  
                  const targetRegion = currentSubRegion || currentRegion;
                  if (!targetRegion) { await sock.sendMessage(from, { text: '🌑 You are not in any region. Use .explore <region> first.', mentions: [sender] }); continue; }
                  
                  const curses = targetRegion.curses.filter(c => c.hp > 0);
                  if (!curses.length) { await sock.sendMessage(from, { text: `🌑 No curses remain in ${targetRegion.name}.`, mentions: [sender] }); continue; }
                  const curse = curses[Math.floor(Math.random() * curses.length)];
                  const enemy = { name: curse.name, grade: curse.grade, stats: { HP: curse.hp, Max_HP: curse.hp, CE: curse.ce, Max_CE: curse.ce }, technique: 'Dark Continent Curse', skills: {} };
                  db.combats[sender] = { player: user, enemy, round: 1, darkRegion: true, regionId: currentRegion?.id || targetRegion.id, subRegionId: currentSubRegion?.id || null, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, host: sender, participants: [sender], distance: 5, ecologicalEvent: null, hallucination: false };
                  saveDb();
                  const locationLabel = currentSubRegion ? `Sub-region: ${currentSubRegion.name}` : `Region: ${currentRegion.name}`;
                  await sock.sendMessage(from, { text: `🌑 *DARK CONTINENT — ENGAGED*\n📍 ${locationLabel}\n👾 ${enemy.name} (Grade ${enemy.grade}) emerges from the shadows!\n───\n*Actions:* .attack | .technique-1..4 | .guard | .flee | .su | .wa | .move\n📏 Distance: 5m | ⚠️ Hazard: ${targetRegion.environmental?.name || 'None'}`, mentions: [sender] });
              }

             else if (command === 'leave-region') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 ensureDarkContinent();
                  const currentRegion = Object.values(db.darkContinent.regions).find(r => jidInArray(sender, r.exploredBy));
                  if (!currentRegion) { await sock.sendMessage(from, { text: '🌑 You are not in any region. Use .explore <region> first.', mentions: [sender] }); continue; }
                  
                  // Check if user is in a sub-region
                  const currentSubRegion = currentRegion.subRegions?.find(sr => jidInArray(sender, sr.exploredBy));
                  if (currentSubRegion) {
                      currentSubRegion.exploredBy = removeJidFromArray(sender, currentSubRegion.exploredBy);
                     const entry = `${new Date().toLocaleTimeString()} — ${user.name || sender.split('@')[0]} left sub-region ${currentSubRegion.name}.`;
                     if (!currentSubRegion.logbook.includes(entry)) currentSubRegion.logbook.push(entry);
                     saveDb();
                     await sock.sendMessage(from, { text: `🚪 You left sub-region *${currentSubRegion.name}*.`, mentions: [sender] });
                  } else {
                      currentRegion.exploredBy = removeJidFromArray(sender, currentRegion.exploredBy);
                     const entry = `${new Date().toLocaleTimeString()} — ${user.name || sender.split('@')[0]} left the region.`;
                     if (!currentRegion.logbook.includes(entry)) currentRegion.logbook.push(entry);
                     saveDb();
                     await sock.sendMessage(from, { text: `🚪 You left *${currentRegion.name}*.`, mentions: [sender] });
                 }
             }
             
              else if (command === 'subs') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                  ensureDarkContinent();
                  const currentRegion = Object.values(db.darkContinent.regions).find(r => jidInArray(sender, r.exploredBy));
                  if (!currentRegion) { await sock.sendMessage(from, { text: '🌑 You are not in any region. Use .explore <region> first.', mentions: [sender] }); continue; }
                 
                 if (!currentRegion.subRegions || !currentRegion.subRegions.length) {
                     await sock.sendMessage(from, { text: `🌑 No sub-regions discovered yet. Keep exploring ${currentRegion.name}...`, mentions: [sender] });
                     continue;
                 }
                 
                 let msg = `🕳️ *SUB-REGIONS: ${currentRegion.name}*\n───\n`;
                  currentRegion.subRegions.forEach((sub, i) => {
                      const explored = jidInArray(sender, sub.exploredBy);
                      const curseCount = sub.curses.filter(c => c.hp > 0).length;
                     msg += `${i + 1}. *${sub.name}* ${explored ? '✅' : '🔒'} | Level: ${sub.level}+ | Danger: ${'⚠️'.repeat(sub.danger)} | Curses: ${curseCount}\n`;
                     if (sub.environmental) msg += `   ⚠️ ${sub.environmental.name}\n`;
                 });
                 msg += `\nUse .sub <name> to enter a sub-region.`;
                 
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
             }
             
              else if (command === 'sub' && args[0]) {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                  if (combat) { await sock.sendMessage(from, { text: 'Already in combat.', mentions: [sender] }); continue; }
                  ensureDarkContinent();
                  const currentRegion = Object.values(db.darkContinent.regions).find(r => jidInArray(sender, r.exploredBy));
                  if (!currentRegion) { await sock.sendMessage(from, { text: '🌑 You are not in any region. Use .explore <region> first.', mentions: [sender] }); continue; }
                 
                 const subName = args.join(' ').toLowerCase();
                 const subRegion = currentRegion.subRegions?.find(s => s.name.toLowerCase().includes(subName));
                 if (!subRegion) { await sock.sendMessage(from, { text: `🌑 Sub-region not found. Use .subs to list available sub-regions.`, mentions: [sender] }); continue; }
                 
                  subRegion.explored = true;
                  addJidToArray(sender, subRegion.exploredBy);
                 
                 // Generate curses if not already generated
                 if (!subRegion.curses?.length) {
                     const curseCount = 1 + Math.floor(Math.random() * 3);
                     const curseNames = ['Cursed Spirit','Accursed Corpse','Disaster Curse','Vengeful Spirit','Born from Fear','Finger Bearer','Corrupted Sorcerer','Womb Curse','Hollow Shade','Rot Walker'];
                     for (let i = 0; i < curseCount; i++) {
                         subRegion.curses.push({
                             name: curseNames[Math.floor(Math.random() * curseNames.length)],
                             grade: Math.min(4, Math.max(0, Math.floor((subRegion.level || 30) / 15) + Math.floor(Math.random() * 2) - 1)),
                             hp: 80 + Math.floor(Math.random() * 200),
                             ce: 60 + Math.floor(Math.random() * 150)
                         });
                     }
                 }
                 
                 const shard = db.darkContinent.shards?.includes(parseInt(subRegion.id.split('-')[0]));
                 let msg = `🕳️ *ENTERED SUB-REGION: ${subRegion.name}*\n`;
                 msg += `Parent: ${currentRegion.name}\n`;
                 msg += `Level: ${subRegion.level}+ | Danger: ${'⚠️'.repeat(subRegion.danger)}\n`;
                 msg += `Curses detected: ${subRegion.curses.length}\n`;
                 
                 if (subRegion.environmental) {
                     const env = subRegion.environmental;
                     msg += `\n⚠️ *ENVIRONMENTAL HAZARD: ${env.name}*\n${env.desc}\n`;
                     
                     if (env.effect === 'decay') {
                         const hpDrain = Math.floor(user.stats.Max_HP * env.hpDrain);
                         const ceDrain = Math.floor(user.stats.Max_CE * env.ceDrain);
                         user.stats.HP = Math.max(1, user.stats.HP - hpDrain);
                         user.stats.CE = Math.max(0, user.stats.CE - ceDrain);
                         msg += `💀 Miasma drains ${hpDrain} HP and ${ceDrain} CE!\n`;
                     } else if (env.effect === 'sanity_drain') {
                         user.sanity = Math.max(0, (user.sanity || 100) - (env.sanityDrain || 5));
                         msg += `🧠 Sanity drops to ${user.sanity}%\n`;
                     }
                 }
                 
                 if (shard && Math.random() < 0.1) {
                     msg += `\n🔮 You sense a *Pandora Shard* resonating nearby...\n`;
                 }
                 
                 msg += `\n📖 *LOGBOOK UPDATED*\n`;
                 subRegion.logbook.push(`${new Date().toLocaleTimeString()} — ${user.name || sender.split('@')[0]} entered the sub-region.`);
                 
                 saveDb();
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
             }

            else if (command === 'g-k-gojo') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                ensureDarkContinent();
                const pb = db.darkContinent.pandoraBox;
                if (pb?.keyFound) { await sock.sendMessage(from, { text: '🔮 The key has already been found.', mentions: [sender] }); continue; }
                const currentRegion = Object.values(db.darkContinent.regions).find(r => r.exploredBy?.includes(sender));
                if (!currentRegion || currentRegion.id !== 44) { await sock.sendMessage(from, { text: '🌑 Gojo is not here. You must find him in Pandora\'s Box region (Region 44).', mentions: [sender] }); continue; }
                pb.locked = true;
                pb.keyFound = false;
                pb.gojoEncountered = true;
                db.darkContinent.shards = [];
                while (db.darkContinent.shards.length < 4) {
                    const rid = 1 + Math.floor(Math.random() * 100);
                    if (!db.darkContinent.shards.includes(rid)) db.darkContinent.shards.push(rid);
                }
                saveDb();
                await sock.sendMessage(from, { text: '👁️ *SATORU GOJO APPEARS*\n\n"Don\'t worry. I\'ve sealed the Pandora key away. It will take another millennium before anyone can open that box."\n\nThe shards have been scattered once more across the Dark Continent.', mentions: [sender] });
            }

             else if (command === 'skills') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 if (user.heavenly_restriction) {
                     const quirks = user.quirks || [];
                     let msg = `⛓️ *HEAVENLY RESTRICTION — QUIRKS* (${quirks.length}/2)\n───\n`;
                     if (quirks.length === 0) {
                         msg += 'No quirks awakened yet. Explore the Dark Continent to awaken quirks.\n';
                     } else {
                         quirks.forEach((q, i) => {
                             msg += `${i + 1}. *${q.name}* (.qk-${i + 1})\n   ${q.desc}\n`;
                         });
                     }
                     msg += `\n💡 Use *.qk-1* and *.qk-2* in combat to unleash your quirks.`;
                     await sock.sendMessage(from, { text: msg, mentions: [sender] });
                     continue;
                 }
                 const skills = db.userSkills?.[sender] || [];
                 if (!skills.length) { await sock.sendMessage(from, { text: 'You have no skills yet. Find scrolls in the Dark Continent or defeat curses to earn them.', mentions: [sender] }); continue; }
                 let msg = `📚 *YOUR SKILLS* (${skills.length}/10)\n───\n`;
                 skills.forEach((sid, i) => {
                     const s = CROSS_UNIVERSE_SKILLS[sid];
                     if (s) msg += `${i + 1}. ${s.name} — ${s.type}\n   ${s.desc}\n`;
                 });
                 if (skills.length >= 10) msg += `\n👑 *TITLE UNLOCKED:* The one blessed by God (+10% CE, +5% DEF)`;
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
             }

            else if (command === 'l-skills') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                let msg = `📖 *ALL CROSS-UNIVERSE SKILLS* (${Object.keys(CROSS_UNIVERSE_SKILLS).length} total)\n───\n`;
                Object.values(CROSS_UNIVERSE_SKILLS).forEach((s, i) => {
                    msg += `${i + 1}. *${s.name}* (${s.type})\n   ${s.desc}\n   DMG: ${s.damage || 0} | CE: ${s.ceCost || 0}\n\n`;
                });
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

             else if (command.startsWith('sk-') && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ *HEAVENLY RESTRICTION:* You cannot use skills. You wield quirks — use .qk-1 or .qk-2.', mentions: [sender] }); continue; }
                 const skills = db.userSkills?.[sender] || [];
                const skillNum = parseInt(command.slice(3));
                if (isNaN(skillNum) || skillNum < 1 || skillNum > 10) { await sock.sendMessage(from, { text: 'Usage: .sk-1 through .sk-10', mentions: [sender] }); continue; }
                const skillId = skills[skillNum - 1];
                if (!skillId) { await sock.sendMessage(from, { text: `No skill equipped in slot ${skillNum}. Use .skills to view.`, mentions: [sender] }); continue; }
                const skill = CROSS_UNIVERSE_SKILLS[skillId];
                if (!skill) { await sock.sendMessage(from, { text: 'Skill data missing.', mentions: [sender] }); continue; }
                 if (combat) {
                     const { enemy } = combat;
                     if (!user.heavenly_restriction && user.stats.CE < (skill.ceCost || 0)) { await sock.sendMessage(from, { text: `⚡ Need ${skill.ceCost} CE for ${skill.name}.`, mentions: [sender] }); continue; }
                     if (!user.heavenly_restriction) user.stats.CE -= skill.ceCost || 0;
                    let dmg = Math.max(1, skill.damage + Math.floor(Math.random() * 10));
                    if (Math.random() < (user._combat_crit_chance || 0.05)) dmg = Math.floor(dmg * 1.5);
                    enemy.stats.HP -= dmg;
                    let effectText = '';
                    if (skill.effect === 'immobilize') { combat.playerStatus = combat.playerStatus || []; combat.playerStatus.push({ name: skill.effect, turns: skill.turns || 1 }); effectText = `\n✨ Immobilized for ${skill.turns || 1} turn(s)!`; }
                    else if (skill.effect === 'stun') { combat.playerStatus = combat.playerStatus || []; combat.playerStatus.push({ name: skill.effect, turns: skill.turns || 1 }); effectText = `\n✨ Stunned for ${skill.turns || 1} turn(s)!`; }
                    else if (skill.effect === 'poison') { combat.playerStatus = combat.playerStatus || []; combat.playerStatus.push({ name: skill.effect, turns: skill.turns || 2, dot: skill.dot || 10 }); effectText = `\n✨ Poisoned!`; }
                    else if (skill.effect === 'defend') { combat.guarding = true; effectText = `\n🛡️ Blocking!`; }
                    else if (skill.effect === 'heal') { user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + (skill.heal || 0)); effectText = `\n💊 Healed!`; }
                    else if (skill.effect === 'sleep') { combat.playerStatus = combat.playerStatus || []; combat.playerStatus.push({ name: skill.effect, turns: skill.turns || 2 }); effectText = `\n✨ Target asleep!`; }
                    else if (skill.effect === 'dodge_next') { combat.guarding = true; effectText = `\n💨 Dodging next attack!`; }
                    else if (skill.effect === 'multi_hit') { const hits = skill.hits || 3; for (let h = 0; h < hits; h++) { if (enemy.stats.HP > 0) enemy.stats.HP -= Math.max(1, Math.floor(skill.damage / hits)); } effectText = `\n💥 ${hits} hits!`; }
                     if (enemy.stats.HP <= 0) {
                         endCombatKeys(combat);
                         const xpBoost = getArmorEffect(user, 'xp_boost') || 0;
                         user.xp += Math.floor(500 * (1 + xpBoost));
                         user.wallet += 1000;
                        user.skill_points = (user.skill_points || 0) + 1;
                        checkLevelUp(user);
                        updateDarkRegionLogbook(combat, user, 'victory');
                        saveDb();
                        await sock.sendMessage(from, { text: `⚡ *${skill.name}* dealt *${dmg}* damage!${effectText}\n💥 ${enemy.name} defeated!\n🎁 +500 XP, +1,000 K-Coins`, mentions: [sender] });
                        continue;
                    }
                    const phase = runEnemyPhase(combat, user);
                    if (user.stats.HP <= 0) {
                        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                        updateDarkRegionLogbook(combat, user, 'defeat');
                        await sock.sendMessage(from, { text: `⚡ *${skill.name}* dealt *${dmg}* damage!${effectText}\n${r}`, mentions: [sender] });
                        continue;
                    }
                    combat.round++;
                    combat.enemyIntent = pickEnemyMove();
                    saveDb();
                    await sock.sendMessage(from, { text: `⚡ *${skill.name}* dealt *${dmg}* damage!${effectText}\n👹 Enemy: ${Math.max(0, enemy.stats.HP)}/${enemy.stats.Max_HP} HP\n👁️ Intent: ${enemyIntentHint(combat.enemyIntent)}`, mentions: [sender] });
                } else {
                    await sock.sendMessage(from, { text: `⚡ *${skill.name}*\n${skill.desc}\nCE Cost: ${skill.ceCost || 0}`, mentions: [sender] });
                }
            }

            else if (command === 'sf-give') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if ((user.fingers || []).length <= 0) { await sock.sendMessage(from, { text: '🚫 *YOU HAVE NO SUKUNA FINGERS TO GIVE.*', mentions: [sender] }); continue; }
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                let targetJid = replyParticipant || (mentioned.length ? mentioned[0] : null);
                if (!targetJid) { await sock.sendMessage(from, { text: '🚫 *TAG OR REPLY TO THE USER YOU WANT TO GIVE A FINGER TO.*', mentions: [sender] }); continue; }
                const targetUser = db.users[targetJid];
                if (!targetUser) { await sock.sendMessage(from, { text: '🚫 *RECIPIENT NOT FOUND IN DATABASE.*', mentions: [sender] }); continue; }
                const finger = user.fingers.pop();
                targetUser.fingers = targetUser.fingers || [];
                targetUser.fingers.push(finger);
                let msg = `🔥 *FINGER TRANSFERRED* — ${user.name || sender.split('@')[0]} gave a Sukuna finger to ${targetUser.name || targetJid.split('@')[0]}.`;
                if ((targetUser.fingers.length >= 20) && !db.sukuna?.active) {
                    spawnSukuna(sock, targetJid, targetUser.name || targetJid.split('@')[0]);
                    msg += `\n⚠️ *ALL 20 FINGERS GATHERED — SUKUNA AWAKENS!*`;
                }
                saveDb();
                await sock.sendMessage(from, { text: msg, mentions: [sender, targetJid] });
            }

            else if (command === 'quests') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                if (db.activeQuest && db.activeQuest.active) {
                    await sock.sendMessage(from, { text: `*A QUEST IS ALREADY ACTIVE:*\n${db.activeQuest.question}\nFirst correct answer wins 4,000 XP and 5,000,000 Gold. Reply in any GC!`, mentions: [sender] }); continue;
                }
                const pickQ = pick(QUEST_POOL);
                db.activeQuest = { question: pickQ.q, answer: pickQ.a, askedBy: sender, askedAt: Date.now(), active: true };
                saveDb();
                broadcastAllGroups(sock, `*📜 KENNYJAKS GLOBAL QUEST 📜*\n${pickQ.q}\n\nFIRST CORRECT ANSWER WINS *4,000 XP* AND *5,000,000 GOLD*.\nREPLY WITH YOUR ANSWER IN ANY GC — ONLY THE FIRST CORRECT ONE COUNTS!`);
                await sock.sendMessage(from, { text: `*QUEST POSTED TO ALL GROUPS!*\n${pickQ.q}\nFirst correct answer wins 4,000 XP and 5,000,000 Gold.`, mentions: [sender] });
            }

              else if (command === 'rct') {
                 if (user.heavenly_restriction) { await sock.sendMessage(from, { text: '💀 *HEAVENLY RESTRICTION:* You have no cursed energy — RCT is impossible.', mentions: [sender] }); continue; }
                 if (!user?.unlocked_features?.RCT) { await sock.sendMessage(from, { text: '⚡ *RCT LOCKED.* Unlock it by surviving a near-death blow in battle (5% chance on a killing blow).'  , mentions: [sender] }); continue; }
                 if (Date.now() < (user._vow_until || 0)) { await sock.sendMessage(from, { text: '🔮 *VOW OF RUIN:* You sacrificed healing for 3 turns — .rct is disabled.', mentions: [sender] }); continue; }
                 const cost = combat ? 0 : Math.floor(user.stats.Max_CE * 0.3);
                 if (!combat && user.stats.CE < cost) { await sock.sendMessage(from, { text: `⚡ Need ${cost} CE to channel Reverse Cursed Technique. You have ${user.stats.CE}.`  , mentions: [sender] }); continue; }
                 const heal = Math.floor(user.stats.Max_HP * 0.7);
                 if (!combat) user.stats.CE = Math.max(0, user.stats.CE - cost);
                 user.stats.HP = Math.min(user.stats.Max_HP, user.stats.HP + heal);
                const heroName = user.name || sender.split('@')[0];
                if (combat) {
                    const { enemy } = combat;
                    const phase = runEnemyPhase(combat, user);
                    if (phase.dead) {
                        const r = await resolveCombatDeath(sock, from, sender, combat, sender, user);
                        if (r === 'ended' || r === 'knocked') continue;
                    }
                    combat.round++;
                    combat.counter_state = false;
                    combat.enemyIntent = pickEnemyMove();
                    saveDb();
                    let log = `${formatUI(user, enemy, combat.round, combat.location || user.current_node)}\n\n`;
                    log += `🧑‍🎓 ${heroName}: channelled *Reverse Cursed Technique* — ${combat ? 'FREE (combat)' : 'spent ' + cost + ' CE'}, restored ${heal} HP.\n`;
                    log += `💥 OUTPUT: 0 DMG (healing)\n\n`;
                    log += `👹 RETRIBUTION: ${phase.enemyDesc}\n`;
                    if (phase.eDamage > 0) log += `☠️ IMPACT: -${phase.eDamage} DMG sustained!\n`;
                    else log += `☠️ IMPACT: 0 DMG sustained (DODGED!)\n`;
                    log += `\n🗣️ NARRATOR: Round ${combat.round}. ${heroName} mends their wounds as ${enemy.name} strikes back${phase.eDamage > 0 ? ` for ${phase.eDamage}` : ' and misses'}.\n`;
                    log += `👁️ ENEMY INTENT: ${enemyIntentHint(combat.enemyIntent)}\n`;
                    log += `╚════════════════════════════════════════╝\n`;
                    log += `*Action Paths:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .technique-5 | .guard | .flee`;
                    const rctText = buildCombatText({
                        combat,
                        user,
                        enemy,
                        heroName,
                        damage: 0,
                        techDisplayName: 'Reverse Cursed Technique',
                        techEffects: [`${combat ? 'FREE' : `-${cost} CE`}, restored ${heal} HP`],
                        phase,
                        isCrit: false,
                        isDodge: false,
                        enemyDotLines: [],
                        summonResult: { log: '' },
                        location: combat.location || user.current_node
                    });
                    await sock.sendMessage(from, { text: rctText, mentions: [sender] });
                } else {
                    saveDb();
                    await sock.sendMessage(from, { text: `⚡ *REVERSE CURSED TECHNIQUE*\nSpent ${cost} CE → restored ${heal} HP (now ${user.stats.HP}/${user.stats.Max_HP}).`   , mentions: [sender] });
                }
            }

            else if (command === 't5r') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                if (!user.unlocked_features?.RCT) { await sock.sendMessage(from, { text: '⚡ *RCT REQUIRED.* You must unlock Reverse Cursed Technique before forging an RCT ability (survive a near-death blow in battle).'  , mentions: [sender] }); continue; }
                if (user.custom_technique) { await sock.sendMessage(from, { text: `🩹 You already forged your RCT technique: *${user.custom_technique.name}* (120 ATK DMG). Use it with .technique-5.`  , mentions: [sender] }); continue; }
                if (args[0]) {
                    const name = args.join(' ').trim();
                    if (name.length < 1) { await sock.sendMessage(from, { text: '⚠️ Give your technique a name: .t5r <name> (max 40 characters).'  , mentions: [sender] }); continue; }
                    if (name.length > 40) { await sock.sendMessage(from, { text: '⚠️ Technique name must be 40 characters or fewer.'  , mentions: [sender] }); continue; }
                    user.custom_technique = { name, damage: 120, cost: 40, custom: true };
                    user.technique_5 = 'custom_t5r';
                    user._await_t5r = false;
                    saveDb();
                    await sock.sendMessage(from, { text: `🩹 *REVERSE CURSED TECHNIQUE FORGED!*\nYour ability **${name}** is now bound (120 ATK DMG, 40 CE).\nUnleash it in battle with *.technique-5*.`  , mentions: [sender] });
                } else {
                    user._await_t5r = true;
                    saveDb();
                    await sock.sendMessage(from, { text: '🩹 *REVERSE CURSED TECHNIQUE*\nName your technique! Reply with *.t5r <name>* (max 40 characters). It will become a 120 ATK battle ability.'  , mentions: [sender] });
                }
            }

            else if (command === 'domain-n') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if (!user.unlocked_features?.Domain) { await sock.sendMessage(from, { text: '🌌 *DOMAIN LOCKED.* You must reach Grade 2 to unlock Domain creation.', mentions: [sender] }); continue; }
                if (user.domain_unlocked) { await sock.sendMessage(from, { text: `🌀 You already forged your Domain: *${user.domain_name}*. It is permanent.`, mentions: [sender] }); continue; }
                if (!args[0]) { await sock.sendMessage(from, { text: '🌀 Name your Domain: `.domain-n <name>` (max 40 chars). Must be done in battle.', mentions: [sender] }); continue; }
                const inBattle = combat || (db.sukuna?.active && db.sukuna.players[sender]) || getPvpMatch(from, sender);
                if (!inBattle) { await sock.sendMessage(from, { text: '🌀 *YOU CAN ONLY FORGE A DOMAIN IN BATTLE.* Enter a fight first, then use `.domain-n <name>`.', mentions: [sender] }); continue; }
                let name = args.join(' ').trim();
                if (name.length > 40) name = name.slice(0, 40);
                user.domain_name = name;
                user.domain_unlocked = true;
                saveDb();
                await sock.sendMessage(from, { text: `🌀 *DOMAIN FORGED:* ${name}!\nIt is now permanent — use \`.domain\` in any battle (PvE, PvP, or the Sukuna raid).`, mentions: [sender] });
            }

              else if (command === 'daily') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  const now = Date.now();
                  const lastDaily = user.lastDailyMissions?.claimedAt || 0;
                  if (now - lastDaily < 24 * 60 * 60 * 1000) {
                      const hoursLeft = Math.ceil((24 * 60 * 60 * 1000 - (now - lastDaily)) / (1000 * 60 * 60));
                      await sock.sendMessage(from, { text: `Daily reward resets in: ${hoursLeft}h`   , mentions: [sender] }); continue;
                  }
                  user.wallet += 10000;
                  user.lastDailyMissions = { claimedAt: now };
                  saveDb();
                  await sock.sendMessage(from, { text: '📅 *Daily reward claimed!* +10000 gold coins.'   , mentions: [sender] });
              }

              else if (command === 'prestige') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  if (!canPrestige(user)) {
                      const canAt = 100;
                      await sock.sendMessage(from, { text: `⚡ *PRESTIGE LOCKED.* Reach level ${canAt} to prestige. Current: ${user.level || 0}.`   , mentions: [sender] }); continue;
                  }
                  const ok = applyPrestige(user);
                  if (ok) {
                      saveDb();
                      await sock.sendMessage(from, { text: `⚡ *PRESTIGE AWARDED!*\nYou have reset your journey and ascended.\nPrestige Level: ${user.prestige}\nPrestige Points: ${user.prestige_points}\nAll progress reset except prestige and statistics.`   , mentions: [sender] });
                  }
              }

              else if (command === 'missions') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  const missions = user.daily_missions || { date: null, missions: [], claimed: false };
                  const today = new Date().toDateString();
                  if (missions.date !== today) {
                      const newMissions = [
                          { id: 1, desc: 'Defeat 3 curses', target: 3, progress: 0, reward: 5000 },
                          { id: 2, desc: 'Win 1 PvP duel', target: 1, progress: 0, reward: 3000 },
                          { id: 3, desc: 'Use 5 techniques', target: 5, progress: 0, reward: 2000 }
                      ];
                      user.daily_missions = { date: today, missions: newMissions, claimed: false };
                      saveDb();
                  }
                  let msg = `📋 *DAILY MISSIONS*\n───\n`;
                  (user.daily_missions.missions || []).forEach((m, i) => {
                      const done = m.progress >= m.target;
                      msg += `${i + 1}. ${done ? '✅' : '◻️'} ${m.desc} (${m.progress}/${m.target}) — Reward: ${m.reward} K-Coins\n`;
                  });
                  msg += `\nUse .claim-missions to collect rewards.`;
                  await sock.sendMessage(from, { text: msg   , mentions: [sender] });
              }

              else if (command === 'claim-missions') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'  , mentions: [sender] }); continue; }
                  const missions = user.daily_missions || { date: null, missions: [], claimed: false };
                  if (missions.claimed) { await sock.sendMessage(from, { text: 'Already claimed today.'   , mentions: [sender] }); continue; }
                  const today = new Date().toDateString();
                  if (missions.date !== today) { await sock.sendMessage(from, { text: 'No active missions. Use .missions first.'   , mentions: [sender] }); continue; }
                  let totalReward = 0;
                  let completed = 0;
                  (missions.missions || []).forEach(m => {
                      if (m.progress >= m.target) {
                          totalReward += m.reward;
                          completed++;
                      }
                  });
                  if (completed === 0) { await sock.sendMessage(from, { text: 'No completed missions yet.'   , mentions: [sender] }); continue; }
                  user.wallet = (user.wallet || 0) + totalReward;
                  user.daily_missions.claimed = true;
                  saveDb();
                  await sock.sendMessage(from, { text: `✅ *MISSIONS CLAIMED*\nCompleted: ${completed}/${missions.missions.length}\nReward: +${fmtNum(totalReward)} K-Coins`   , mentions: [sender] });
              }

              else if (command === 'fish') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                  const now = Date.now();
                  const lastFish = user.last_fish || 0;
                  const fishCooldown = 5 * 60 * 1000;
                  if (now - lastFish < fishCooldown) {
                      const remaining = Math.ceil((fishCooldown - (now - lastFish)) / 1000);
                      await sock.sendMessage(from, { text: `🎣 *FISH COOLDOWN*\nWait ${remaining}s before fishing again.`, mentions: [sender] });
                      continue;
                  }
                  if (Math.random() < 0.78) {
                      user.inventory = user.inventory || [];
                      user.inventory.push({ name: 'Fish', type: 'consumable', desc: 'A fresh fish caught from the waters.' });
                      const xpGain = 78 + Math.floor(Math.random() * 78);
                      user.xp = (user.xp || 0) + xpGain;
                      checkLevelUp(user);
                      user.last_fish = now;
                      saveDb();
                      await sock.sendMessage(from, { text: `🎣 *FISH CAUGHT!*\nYou caught a Fish! (Added to inventory)\n🎣 +${xpGain} XP`, mentions: [sender] });
                  } else {
                      user.last_fish = now;
                      saveDb();
                      await sock.sendMessage(from, { text: '🎣 *FISH ESCAPED!* The fish got away. Try again!', mentions: [sender] });
                  }
              }

             else if (command === 'b-invite') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '*YOU ARE IN THE SUKUNA RAID — CO-OP IS DISABLED THERE.*'  , mentions: [sender] }); continue; }
                const isVillageHost = combat && combat.missionFight && combat.host === sender;
                if (!combat || (!isVillageHost && combat.host !== sender)) { await sock.sendMessage(from, { text: '🤝 Only the host of a co-op battle or village mission can invite. Engage a curse with `.b-curse` or accept a village mission first.'   , mentions: [sender] }); continue; }
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                let targetJid = null;
                if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                if (!targetJid) { await sock.sendMessage(from, { text: '🤝 Tag the sorcerer to invite: `.b-invite @user`'   , mentions: [sender] }); continue; }
                if (targetJid === sender) { await sock.sendMessage(from, { text: '🤝 You cannot invite yourself.'   , mentions: [sender] }); continue; }
                if ((combat.participants || []).length >= 5) { await sock.sendMessage(from, { text: '🤝 Party is full (max 5 members).'   , mentions: [sender] }); continue; }
                const targetUser = db.users[targetJid];
                if (!targetUser || !targetUser.registered) { await sock.sendMessage(from, { text: '🤝 That sorcerer is not registered.'   , mentions: [sender] }); continue; }
                combat.invites = combat.invites || [];
                if (combat.participants.includes(targetJid)) { await sock.sendMessage(from, { text: '🤝 That sorcerer is already in this battle.'   , mentions: [sender] }); continue; }
                if (combat.invites.includes(targetJid)) { await sock.sendMessage(from, { text: '🤝 Invite already sent to that sorcerer.'   , mentions: [sender] }); continue; }
                combat.invites.push(targetJid);
                saveDb();
                await sock.sendMessage(from, { text: `🤝 *CO-OP INVITE*\n${user.name || sender} invites ${targetUser.name || targetJid} to a party against *${combat.enemy.name}*!\nReply with *.b-i-a* to join the battle.\nParty: ${combat.participants.length + 1}/5`, mentions: [targetJid, sender] });
            }

             else if (command === 'b-i-a') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '*YOU ARE IN THE SUKUNA RAID.*'  , mentions: [sender] }); continue; }
                if (db.combats[sender]) { await sock.sendMessage(from, { text: '🤝 You are already in a battle. Finish or flee it first.'   , mentions: [sender] }); continue; }
                let hostCombat = null, hostJid = null;
                for (const [jid, c] of Object.entries(db.combats)) {
                    if (c.invites && c.invites.includes(sender)) { hostCombat = c; hostJid = jid; break; }
                }
                if (!hostCombat) { await sock.sendMessage(from, { text: '🤝 No pending co-op invite for you. Get invited with `.b-invite @you`.'   , mentions: [sender] }); continue; }
                if ((hostCombat.participants || []).length >= 5) { await sock.sendMessage(from, { text: '🤝 Party is full (max 5 members).', mentions: [sender] }); continue; }
                hostCombat.invites = hostCombat.invites.filter(j => j !== sender);
                hostCombat.participants.push(sender);
                db.combats[sender] = hostCombat; // share the SAME combat object
                user.stats.HP = user.stats.Max_HP;
                user.stats.CE = user.stats.Max_CE;
                saveDb();
                const allyName = user.name || sender;
                const hostName = db.users[hostJid]?.name || hostJid;
                await sock.sendMessage(from, { text: `🤝 *${allyName} JOINED THE CO-OP BATTLE!*\nIt's now a ${hostCombat.participants.length}v1 against *${hostCombat.enemy.name}*.\nYour attacks are live — use .attack / .technique-1..5 / .guard / .rct as normal.`, mentions: [sender, hostJid] });
             }

            else if (command === 'jk') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.loots?.includes('jackpot')) { await sock.sendMessage(from, { text: '🎰 *JACKPOT LOCKED.* You need the JACKPOT loot to use this.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) {
                    const me = db.sukuna.players[sender];
                    user._jackpot_until = Date.now() + 360000;
                    me.hp = me.maxHp;
                    saveDb();
                    await sock.sendMessage(from, { text: `🎰 *JACKPOT ACTIVATED!*\nInfinite HP/CE for the next 6 minutes — Sukuna cannot bring you down!\n⚡ Reverse Cursed Technique permanently unlocked!`, mentions: [sender] });
                    continue;
                }
                if (!combat) { await sock.sendMessage(from, { text: '🎰 JACKPOT can only be triggered in battle.'   , mentions: [sender] }); continue; }
                user._jackpot_until = Date.now() + 360000;
                user.stats.HP = user.stats.Max_HP;
                user.stats.CE = user.stats.Max_CE;
                if (!user.unlocked_features?.RCT) {
                    user.unlocked_features.RCT = true;
                    user.stats.HP = 1;
                }
                saveDb();
                await sock.sendMessage(from, { text: `🎰 *JACKPOT ACTIVATED!*\nInfinite HP/CE for the next 6 minutes — nothing can bring you down!\n⚡ Reverse Cursed Technique permanently unlocked!`   , mentions: [sender] });
            }

            else if (command === 'taunt') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.loots?.includes('honoured_one')) { await sock.sendMessage(from, { text: '🦁 *HONOURED ONE LOCKED.* You need the HONOURED ONE loot to taunt.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) {
                    const heroName = user.name || sender.split('@')[0];
                    await sock.sendMessage(from, { text: `🦁 *${heroName} RADIATES AN OVERWHELMING AURA!*\nSukuna, the strongest curse in history, is unfazed — but your presence is undeniable.`, mentions: [sender] });
                    continue;
                }
                if (!combat) { await sock.sendMessage(from, { text: '🦁 You can only taunt in battle.'   , mentions: [sender] }); continue; }
                const { enemy } = combat;
                const heroName = user.name || sender.split('@')[0];
                if ((enemy.grade ?? 4) <= (user.grade ?? 4)) {
                    // Weaker/equal enemy is scared off — the battle ends (no loot, it fled).
                    endCombatKeys(combat);
                    saveDb();
                    await sock.sendMessage(from, { text: `🦁 *${heroName} TAUNTS ${enemy.name}!*\nThe lesser curse trembles and flees the battlefield in terror. The fight is over.`   , mentions: [sender] });
                } else {
                    await sock.sendMessage(from, { text: `🦁 *${heroName} RADIATES AN OVERWHELMING AURA!*\n${enemy.name} is unfazed — it's stronger than you. But your presence is undeniable.`   , mentions: [sender] });
                }
            }

            else if (command === 'spawn-curse') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '*YOU ARE IN THE SUKUNA RAID — YOU CANNOT START ANOTHER FIGHT.*'  , mentions: [sender] }); continue; }
                if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); continue; }
                if (user.active_curse_spawn) { await sock.sendMessage(from, { text: 'A curse is already manifesting! Use `.b-curse` or wait for it to dissipate.'  , mentions: [sender] }); continue; }
                if (CURSES.length === 0) { await sock.sendMessage(from, { text: 'Curse index is empty.'   , mentions: [sender] }); continue; }
                const curse = getRandomCurse();
                user.active_curse_spawn = {
                    curse: curse,
                    spawnedAt: Date.now()
                };
                await sock.sendMessage(from, { text: `👁️ **CURSE MANIFESTATION DETECTED**\n───\n**${curse.name}**\nRegion: ${curse.region}\nGrade: ${curse.grade}\nPower Level: ${curse.powerLevel.toLocaleString()} PL\n───\n*Type \`.b-curse\` within 60 seconds to engage!*`   , mentions: [sender] });
            }

            else if (command === 'b-curse') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (db.sukuna?.active && db.sukuna.players[sender]) { await sock.sendMessage(from, { text: '*YOU ARE IN THE SUKUNA RAID — YOU CANNOT START ANOTHER FIGHT.*'  , mentions: [sender] }); continue; }
                if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); continue; }
                if (!user.active_curse_spawn) { await sock.sendMessage(from, { text: 'No active curse manifestation. Use `.spawn-curse` first.'   , mentions: [sender] }); continue; }
                
                const spawn = user.active_curse_spawn;
                const elapsed = Date.now() - spawn.spawnedAt;
                if (elapsed > 60000) {
                    user.active_curse_spawn = null;
                    saveDb();
                    await sock.sendMessage(from, { text: '💨 The curse has dissipated into the void! Too slow...'   , mentions: [sender] });
                    continue;
                }
                
                const curse = spawn.curse;
                user.active_curse_spawn = null;
                
                // A manifested curse is scaled to match the summoner's own grade tier,
                // so a grade-4 rookie meets a grade-4 curse and a Special Grade sorcerer
                // faces a Special Grade threat.
                const grade = getEffectiveGrade(user);
                const gradeName = GRADE_NAMES[grade] || 'Grade 4';
                const base = CURSE_GRADE_STATS[grade] || CURSE_GRADE_STATS[4];
                const scale = 1 + (user.level - 1) * 0.05;
                const hp = Math.max(15, Math.floor(base.hp * scale));
                const atk = Math.max(1, Math.floor(base.atk * scale));

                const enemy = {
                    name: curse.name,
                    grade: grade,
                    stats: { HP: hp, Max_HP: hp, CE: base.ce, Max_CE: base.ce, Output: 1, Refinement: 10 },
                    atk: atk,
                    originalMaxHP: hp,
                    technique: 'Stalker Curse',
                    canDomain: true,
                    domainChance: 0.12,
                    skills: {}
                };
                
                db.combats[sender] = { player: user, enemy, round: 1, location: curse.region, weaponOnly: true, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, host: sender, participants: [sender] };
                saveDb();
                await sock.sendMessage(from, { text: `⚔️ **CURSE ENGAGED**\n───\n**${curse.name}**\nGrade: ${gradeName} (matched to your tier) | PL: ${curse.powerLevel.toLocaleString()}\nRegion: ${curse.region}\n───\n👁️ It's preparing: ${enemyIntentHint(db.combats[sender].enemyIntent)}\n*Directives:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .technique-5 | .guard | .flee`   , mentions: [sender] });
            }



            else if (command === 'withdraw' && args[0]) {
                if (!user?.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const amt = parseInt(args[0]);
                if (isNaN(amt) || amt <= 0 || user.bank < amt) { await sock.sendMessage(from, { text: 'Invalid or insufficient bank amount.'   , mentions: [sender] }); continue; }
                user.bank -= amt;
                user.wallet += amt;
                saveDb();
                await sock.sendMessage(from, { text: `Withdrew ${amt} gold. Wallet: ${user.wallet} | Bank: ${user.bank}`   , mentions: [sender] });
            }

            else if (command === 'deposit' && args[0]) {
                if (!user?.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const amt = parseInt(args[0]);
                if (isNaN(amt) || amt <= 0 || user.wallet < amt) { await sock.sendMessage(from, { text: 'Invalid or insufficient wallet amount.'   , mentions: [sender] }); continue; }
                user.wallet -= amt;
                user.bank += amt;
                saveDb();
                await sock.sendMessage(from, { text: `Deposited ${amt} gold. Wallet: ${user.wallet} | Bank: ${user.bank}`   , mentions: [sender] });
            }

            else if (command === 'wallet') {
                if (user) {
                    const wallet = user.wallet || 0;
                    const bank = user.bank || 0;
                    const total = wallet + bank;
                    const maxCapacity = 5000000 + (user.level || 1) * 160000;
                    const money = (n) => '$' + Math.floor(n).toLocaleString('en-US');
                    const cap = '$' + fmtNum(maxCapacity);
                    const msg = `🎴 𝗔𝗖𝗖𝗢𝗨𝗡𝗧 𝗕𝗔𝗟𝗔𝗡𝗖𝗘
━━━━━━━━━━━━━━━━━
💰 𝗪𝗮𝗹𝗹𝗲𝘁: 〘 ${money(wallet)}
🏦 𝗕𝗮𝗻𝗸: 〘 ${money(bank)}
🌌 𝗠𝗮𝘅 𝗖𝗮𝗽𝗮𝗰𝗶𝘁𝘆: 〘 ${cap}
💠 𝗧𝗼𝘁𝗮𝗹: 〘 ${money(total)} 〙`;
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
                 }
             }

              else if (command === 'train') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                  const sp = user.skill_points || 0;
                  const ts = user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 };
                  const base = calcPower(user);
                  const msg = `💪 *TRAINING STATS* — ${user.name || sender.split('@')[0]}
 ━━━━━━━━━━━━━━━━━━
 ⚔️ Attack: ${base.attack} (trained +${ts.attack})
 🛡️ Defense: ${base.defense} (trained +${ts.defense})
 ❤️ Max HP: ${user.stats.Max_HP} (trained +${ts.max_hp})
 ⚡ Max CE: ${user.stats.Max_CE} (trained +${ts.max_ce})
 🏃 Speed: ${base.speed} (trained +${ts.speed})
 🏆 Level: ${user.level} | Grade: ${user.grade}
 ━━━━━━━━━━━━━━━━━━
 🎯 Skill Points Available: *${sp}*
 ━━━━━━━━━━━━━━━━━━
 Use *.t-s <stat> <amount>* to allocate points.
 Stats: attack, defense, max_hp, max_ce, speed`;
                  await sock.sendMessage(from, { text: msg, mentions: [sender] });
              }

              else if (command === 't-s') {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                  const sp = user.skill_points || 0;
                  if (sp <= 0) { await sock.sendMessage(from, { text: '🎯 No skill points available. Win battles to earn skill points!', mentions: [sender] }); continue; }
                  const stat = (args[0] || '').toLowerCase();
                  const amt = parseInt(args[1]) || 0;
                  const validStats = ['attack', 'defense', 'max_hp', 'max_ce', 'speed'];
                  if (!validStats.includes(stat)) { await sock.sendMessage(from, { text: `Invalid stat. Choose from: ${validStats.join(', ')}`, mentions: [sender] }); continue; }
                  if (isNaN(amt) || amt <= 0) { await sock.sendMessage(from, { text: 'Specify a valid amount to allocate.', mentions: [sender] }); continue; }
                  if (amt > sp) { await sock.sendMessage(from, { text: `You only have ${sp} skill points.`, mentions: [sender] }); continue; }
                  user.trained_stats = user.trained_stats || { attack: 0, defense: 0, max_hp: 0, max_ce: 0, speed: 0 };
                  user.trained_stats[stat] = (user.trained_stats[stat] || 0) + amt;
                  user.skill_points = sp - amt;
                  recalcStats(user);
                  saveDb();
                  await sock.sendMessage(from, { text: `✅ Allocated *${amt}* skill points to *${stat}*.\nNew ${stat}: ${user.trained_stats[stat]}\nRemaining SP: ${user.skill_points}`, mentions: [sender] });
              }

             else if (command === 'send') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const amt = parseInt(args[0]);
                 if (isNaN(amt) || amt <= 0) { await sock.sendMessage(from, { text: 'Usage: .send <amount> @user', mentions: [sender] }); continue; }
                 if (amt > (user.wallet || 0)) { await sock.sendMessage(from, { text: `You only have ${fmtNum(user.wallet)} in your wallet.`, mentions: [sender] }); continue; }
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 let targetJid = null;
                 if (replyParticipant) targetJid = replyParticipant;
                 else if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                 if (!targetJid || targetJid === sender) { await sock.sendMessage(from, { text: 'Tag a user to send money to.', mentions: [sender] }); continue; }
                 const targetUser = db.users[targetJid];
                 if (!targetUser || !targetUser.registered) { await sock.sendMessage(from, { text: 'Target user not found.', mentions: [sender] }); continue; }
                 user.wallet -= amt;
                 targetUser.wallet = (targetUser.wallet || 0) + amt;
                 saveDb();
                 await sock.sendMessage(from, { text: `💸 Sent *${fmtNum(amt)}* to ${targetUser.name || targetJid}.\nYour wallet: ${fmtNum(user.wallet)}`, mentions: [sender, targetJid] });
             }

             else if (command === 'rob') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 let targetJid = null;
                 if (replyParticipant) targetJid = replyParticipant;
                 else if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                 if (!targetJid || targetJid === sender) { await sock.sendMessage(from, { text: 'Tag a user to rob.', mentions: [sender] }); continue; }
                 const targetUser = db.users[targetJid];
                 if (!targetUser || !targetUser.registered) { await sock.sendMessage(from, { text: 'Target user not found.', mentions: [sender] }); continue; }
                 const myWallet = user.wallet || 0;
                 const targetWallet = targetUser.wallet || 0;
                 if (targetWallet < 100) { await sock.sendMessage(from, { text: `${targetUser.name || targetJid} is too poor to rob (under 100).`, mentions: [sender] }); continue; }
                 const success = Math.random() < 0.67;
                 if (success) {
                     const stolen = Math.max(1, Math.floor(targetWallet * 0.05));
                     targetUser.wallet = Math.max(0, targetWallet - stolen);
                     user.wallet = myWallet + stolen;
                     saveDb();
                     await sock.sendMessage(from, { text: `🦹 *ROB SUCCESSFUL!*\nYou stole *${fmtNum(stolen)}* (5%) from ${targetUser.name || targetJid}!\nYour wallet: ${fmtNum(user.wallet)}`, mentions: [sender, targetJid] });
                 } else {
                     const penalty = Math.max(1, Math.floor(myWallet * 0.10));
                     user.wallet = Math.max(0, myWallet - penalty);
                     saveDb();
                     await sock.sendMessage(from, { text: `🚨 *ROB FAILED!*\nYou were caught and lost *${fmtNum(penalty)}* (10%) from your wallet!\nYour wallet: ${fmtNum(user.wallet)}`, mentions: [sender] });
                 }
             }

             else if (command === 'shops') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 let msg = '╔══════════════════════════════════════╗\n   🗡️ 𝔎𝔈ℕℕ𝔜𝔍𝔄𝔎𝔖 : 𝔠𝔲𝔯𝔰𝔢𝔡 𝔱𝔬𝔬𝔩𝔰\n╚══════════════════════════════════════╝\n';
                 msg += '⚠️ *One weapon per sorcerer.* Buy with `.buyw <id>` — it equips automatically.\n──────────────────────────────────────────\n';
                 for (const w of WEAPON_SHOP) {
                     msg += `⚔️ [${w.id}] ${w.name}\n`;
                     msg += `   📈 Potency: ${w.potency} | 💥 ${w.effect}\n`;
                     msg += `   🪙 ${fmtNum(w.cost)} K-Coins\n`;
                     msg += `   📝 ${w.desc}\n`;
                     msg += `──────────────────────────────────────────\n`;
                 }
                 msg += `🗡️ Your weapon: ${user.weapon ? user.weapon.name + ' (.wa = ' + (user.wa_attack || 6) + ')' : 'None — buy one above.'}`;
                 await sock.sendMessage(from, { text: msg   , mentions: [sender] });
             }

             else if (command === 'shopc') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 let msg = `🥋 *ARMOR CATALOG*\n\n`;
                 const tiers = [
                     { name: 'Lower Tier: Trainee Garb', armors: ARMOR_SHOP.filter(a => a.id <= 2) },
                     { name: 'Mid Tier: Semi-Grade 1 Tactical Gear', armors: ARMOR_SHOP.filter(a => a.id >= 3 && a.id <= 4) },
                     { name: 'High Tier: Grade 1 & Special Grade Vestments', armors: ARMOR_SHOP.filter(a => a.id >= 5 && a.id <= 6) },
                     { name: 'Endgame Legendary Set', armors: ARMOR_SHOP.filter(a => a.id >= 7 && a.id <= 11) }
                 ];
                 for (const tier of tiers) {
                     msg += `\n🥋 ${tier.name}\n\n`;
                     msg += `╔════════════════════════════════════════╗\n`;
                     msg += `𝔎𝔈𝔑𝔎𝔈𝔑𝔑𝔜𝔍𝔔𝔎𝔖 : 𝔒𝔘𝔗𝔉ℑ𝔗 ℜ𝔈𝔊ℑ𝔖𝔗𝔍𝔜\n`;
                     msg += `╚════════════════════════════════════════╝\n`;
                     for (const a of tier.armors) {
                         msg += `🧥 SET: ${a.name}\n`;
                         msg += `🪙 COST: ${fmtNum(a.cost)} K-Coins\n`;
                         msg += `🛡️ DEFENSE: +${a.stats.defense} Base Armor\n`;
                         msg += `🌟 PASSIVE PERK: [${a.effect.desc.split('.').shift()}]\n`;
                         msg += `📝 EFFECT: ${a.effect.desc}\n`;
                         if (a !== tier.armors[tier.armors.length - 1]) msg += `──────────────────────────────────────────\n`;
                     }
                     msg += `╚════════════════════════════════════════╝\n`;
                 }
                 msg += `\n*Buy with* \`.buyc <name>\` *— item goes to inventory, then* \`.equip <name>\` *to wear it.*`;
                 await sock.sendMessage(from, { text: msg   , mentions: [sender] });
             }

             else if (command === 'buyc' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const itemName = args.join(' ');
                 const item = ARMOR_SHOP.find(a => a.name.toLowerCase() === itemName.toLowerCase());
                 if (!item) { await sock.sendMessage(from, { text: 'Armor not found. Use .shopc to see available sets.', mentions: [sender] }); continue; }
                 if (user.wallet < item.cost) { await sock.sendMessage(from, { text: `🪙 Need ${fmtNum(item.cost)} K-Coins. You have ${fmtNum(user.wallet)}.`, mentions: [sender] }); continue; }
                 user.wallet -= item.cost;
                 user.inventory = user.inventory || [];
                 user.inventory.push({
                     name: item.name,
                     type: 'armor',
                     slot: item.slot,
                     stats: item.stats,
                     rarity: item.rarity,
                     rarityName: item.rarityName,
                     rarityColor: item.rarityColor,
                     effect: item.effect,
                     durability: 100
                 });
                 saveDb();
                 await sock.sendMessage(from, { text: `🥋 *ARMOR ACQUIRED!*\n🧥 ${item.rarityColor || ''}${item.name}\n🛡️ +${item.stats.defense} Defense\n🌟 ${item.effect.desc}\n🪙 -${fmtNum(item.cost)} K-Coins\n\nUse *.equip ${item.name}* to wear it.`, mentions: [sender] });
             }


             else if (command === 'buyw' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const id = parseInt(args[0]);
                 const item = WEAPON_SHOP.find(w => w.id === id);
                 if (!item) { await sock.sendMessage(from, { text: '*INVALID WEAPON ID.* Use .shops to see the list.', mentions: [sender] }); continue; }
                 if (user.wallet < item.cost) { await sock.sendMessage(from, { text: `🪙 Need ${fmtNum(item.cost)} K-Coins. You have ${fmtNum(user.wallet)}.`, mentions: [sender] }); continue; }
                 user.wallet -= item.cost;
                 user.weapons_owned = user.weapons_owned || [];
                 const weaponEntry = { id: item.id, name: item.name, potency: item.potency, effect: item.effect };
                 user.weapons_owned.push(weaponEntry);
                 if (!user.heavenly_restriction) {
                     if (user.weapon) { await sock.sendMessage(from, { text: '*YOU ALREADY OWN A WEAPON.* One weapon per sorcerer — you cannot own another.', mentions: [sender] }); continue; }
                     user.weapon = weaponEntry;
                 } else {
                     user.weapon = weaponEntry;
                 }
                 saveDb();
                 await sock.sendMessage(from, {
                     text: `🗡️ *WEAPON ACQUIRED!*\n⚔️ ${item.name}\n📈 ${item.potency} | 💥 ${item.effect}\n🪙 -${fmtNum(item.cost)} K-Coins\n\nIt is now equipped. Use *.wa* in battle to strike (base 6 dmg).${user.heavenly_restriction ? '\n⛓️ As an HR user you may own multiple weapons. Switch with .waeq <num> or use .wa1, .wa2, etc. in combat.' : ''}\n⛓️ Defeat a *Special Grade* curse using *only* .wa strikes to awaken *HEAVENLY RESTRICTION* — your .wa becomes 200 and your .attack becomes 150!`,
                     mentions: [sender]
                 });
             }

               else if (command === 'waeq' && args[0]) {
                   if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                   if (!user.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ Multi-weapon loadouts are exclusive to *HEAVENLY RESTRICTION* users.', mentions: [sender] }); continue; }
                   const idx = parseInt(args[0]) - 1;
                   const owned = user.weapons_owned || [];
                   if (idx < 0 || idx >= owned.length) { await sock.sendMessage(from, { text: `Invalid weapon slot. You own ${owned.length} weapon(s). Use .shops to buy more.`, mentions: [sender] }); continue; }
                   user.weapon = owned[idx];
                   saveDb();
                   await sock.sendMessage(from, { text: `🗡️ *WEAPON EQUIPPED*\n⚔️ ${user.weapon.name}\n📈 ${user.weapon.potency} | 💥 ${user.weapon.effect}`, mentions: [sender] });
               }

               else if (command === 'weapons') {
                   if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                   if (!user.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ Multi-weapon loadouts are exclusive to *HEAVENLY RESTRICTION* users.', mentions: [sender] }); continue; }
                   const owned = user.weapons_owned || [];
                   const active = user.weapon;
                   let msg = `🗡️ *YOUR WEAPONS* (${owned.length})\n───\n`;
                   if (owned.length === 0) {
                       msg += 'No weapons owned. Use .shops to buy weapons.\n';
                   } else {
                       owned.forEach((w, i) => {
                           const activeMark = active && active.id === w.id ? ' *(EQUIPPED)*' : '';
                           msg += `${i + 1}. ⚔️ ${w.name}${activeMark}\n   📈 ${w.potency} | 💥 ${w.effect}\n`;
                       });
                   }
                   msg += `\n💡 Use .wa1, .wa2, etc. in combat to switch weapons.\n   Use .waeq <num> to equip a weapon outside combat.`;
                   await sock.sendMessage(from, { text: msg, mentions: [sender] });
               }

              else if (command === 'seal' && args[0]) {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                  const activeWeapon = user.weapon;
                  if (!activeWeapon || activeWeapon.name !== 'Prison Realm') { await sock.sendMessage(from, { text: '🔒 *PRISON REALM REQUIRED.* You must have Prison Realm equipped to use .seal.', mentions: [sender] }); continue; }
                  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                  const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                  let targetJid = replyParticipant || (mentioned.length > 0 ? mentioned[0] : null);
                  if (!targetJid) { await sock.sendMessage(from, { text: '🚫 Tag or reply to the user you want to seal.', mentions: [sender] }); continue; }
                  if (sameJid(targetJid, sender)) { await sock.sendMessage(from, { text: '🔒 You cannot seal yourself.', mentions: [sender] }); continue; }
                  const targetUser = db.users[targetJid];
                  if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                  if (targetUser.prisonRealm && Date.now() < (targetUser.prisonRealm.releasedAt || 0)) { await sock.sendMessage(from, { text: '🔒 That user is already sealed in Prison Realm.', mentions: [sender] }); continue; }
                  targetUser.prisonRealm = { sealedBy: sender, sealedAt: Date.now(), releasedAt: Date.now() + 24 * 60 * 60 * 1000 };
                  saveDb();
                  await sock.sendMessage(from, { text: `🔒 *PRISON REALM*\n${targetUser.name || targetJid} has been sealed away for *24 hours*.\nThey cannot use any commands or techniques.\nTo free them, defeat you in PvP using *Playful Cloud* or *Black Rope*, or have a *Limitless* user defeat you.`, mentions: [sender, targetJid].filter(Boolean) });
                  try { await sock.sendMessage(targetJid, { text: '🔒 *YOU HAVE BEEN SEALED IN THE PRISON REALM*\nYou are trapped for 24 hours. All commands and techniques are blocked.\nThe only way out is for someone to defeat your captor in PvP using Playful Cloud or Black Rope, or for a Limitless user to defeat them.', mentions: [targetJid] }); } catch {}
              }

              else if (command === 'unseal' && args[0]) {
                  if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                  const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                  let targetJid = replyParticipant || (mentioned.length > 0 ? mentioned[0] : null);
                  if (!targetJid) { await sock.sendMessage(from, { text: '🚫 Tag or reply to the user you want to unseal.', mentions: [sender] }); continue; }
                  const targetUser = db.users[targetJid];
                  if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                  if (!targetUser.prisonRealm || Date.now() >= (targetUser.prisonRealm.releasedAt || 0)) { await sock.sendMessage(from, { text: '🔓 That user is not sealed in Prison Realm.', mentions: [sender] }); continue; }
                  if (!sameJid(targetUser.prisonRealm.sealedBy, sender)) { await sock.sendMessage(from, { text: '🔒 Only the captor who sealed this user can release them.', mentions: [sender] }); continue; }
                  targetUser.prisonRealm = null;
                  saveDb();
                  await sock.sendMessage(from, { text: `🔓 *PRISON REALM RELEASED*\nYou have freed *${targetUser.name || targetJid}* from the Prison Realm.`, mentions: [sender, targetJid].filter(Boolean) });
                  try { await sock.sendMessage(targetJid, { text: `🔓 *PRISON REALM BROKEN*\n${user.name || sender} has released you from the Prison Realm. You are free to move again.`, mentions: [targetJid] }); } catch {}
              }

             else if (command === 'shop-create' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (user.shop?.has_shop) { await sock.sendMessage(from, { text: 'You already own a shop.'   , mentions: [sender] }); continue; }
                const cost = 1500;
                if (user.wallet < cost) { await sock.sendMessage(from, { text: `Need ${cost} K-Coins to establish a shop.`   , mentions: [sender] }); continue; }
                const name = args.join(' ');
                user.wallet -= cost;
                user.shop = {
                    has_shop: true,
                    node: user.current_node,
                    name: name,
                    inventory: [],
                    vault: 0
                };
                saveDb();
                await sock.sendMessage(from, { text: `╔════════════════════════════════════════╗\n   🏪 SHOP ESTABLISHED\n╚════════════════════════════════════════╝\n> Name: ${name}\n> Location: ${user.current_node}\n> Investment: -${cost} K-Coins\n> Status: Open for business\n╚════════════════════════════════════════╝`   , mentions: [sender] });
            }

            else if (command === 'shop-stock' && args.length >= 3) {
                if (!user || !user.registered || !user.shop?.has_shop) { await sock.sendMessage(from, { text: 'You need an active shop.'   , mentions: [sender] }); continue; }
                const itemName = args[0];
                const price = parseInt(args[1]);
                const qty = parseInt(args[2]);
                if (isNaN(price) || isNaN(qty) || price <= 0 || qty <= 0) { await sock.sendMessage(from, { text: 'Usage: .shop-stock <item_name> <price> <qty>'   , mentions: [sender] }); }
                const invIdx = user.inventory.findIndex(i => i.name === itemName);
                if (invIdx === -1) { await sock.sendMessage(from, { text: 'Item not found in your inventory.'   , mentions: [sender] }); }
                const item = user.inventory[invIdx];
                user.inventory.splice(invIdx, 1);
                for (let i = 0; i < qty; i++) {
                    user.shop.inventory.push({ ...item, shopPrice: price, shopQty: 1 });
                }
                saveDb();
                await sock.sendMessage(from, { text: `Stocked ${qty}x ${itemName} at ${price} K-Coins each.`   , mentions: [sender] });
            }

            else if (command === 'shop-buy' && args.length >= 2) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const ownerJid = args[0];
                const itemName = args.slice(1).join(' ');
                const owner = db.users[ownerJid];
                if (!owner?.shop?.has_shop) { await sock.sendMessage(from, { text: 'Shop not found.'   , mentions: [sender] }); continue; }
                if (owner.shop.node !== user.current_node) { await sock.sendMessage(from, { text: 'Shop is not at your current location.'   , mentions: [sender] }); continue; }
                const shopItemIdx = owner.shop.inventory.findIndex(i => i.name === itemName);
                if (shopItemIdx === -1) { await sock.sendMessage(from, { text: 'Item not available in this shop.'   , mentions: [sender] }); continue; }
                const shopItem = owner.shop.inventory[shopItemIdx];
                if (user.wallet < shopItem.shopPrice) { await sock.sendMessage(from, { text: `Insufficient funds. Need ${shopItem.shopPrice} K-Coins.`   , mentions: [sender] }); continue; }
                user.wallet -= shopItem.shopPrice;
                owner.shop.vault = (owner.shop.vault || 0) + shopItem.shopPrice;
                owner.shop.inventory.splice(shopItemIdx, 1);
                user.inventory.push({ name: shopItem.name, type: shopItem.type, stats: shopItem.stats, rarity: shopItem.rarity, rarityName: shopItem.rarityName, rarityColor: shopItem.rarityColor, durability: shopItem.durability });
                saveDb();
                await sock.sendMessage(from, { text: `Purchased ${shopItem.name} for ${shopItem.shopPrice} K-Coins.`   , mentions: [sender] });
            }

            else if (command === 'shop-info') {
                if (!user || !user.registered || !user.shop?.has_shop) { await sock.sendMessage(from, { text: 'You need an active shop.'   , mentions: [sender] }); continue; }
                const s = user.shop;
                const itemCounts = {};
                (s.inventory || []).forEach(i => { itemCounts[i.name] = (itemCounts[i.name] || 0) + 1; });
                let msg = '╔════════════════════════════════════════╗\n   🏪 SHOP INFO\n╚════════════════════════════════════════╝\n';
                msg += `> Name: ${s.name}\n> Location: ${s.node}\n> Vault: ${s.vault} K-Coins\n> Items Listed: ${s.inventory?.length || 0}\n──────────────────────────────────────────\n`;
                Object.entries(itemCounts).forEach(([name, count]) => {
                    msg += `> 📦 ${name}: ${count}\n`;
                });
                msg += '╚════════════════════════════════════════╝';
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

            else if (command === 'gamble') {
                await sock.sendMessage(from, { text: '🎰 **CURSED CASINO** 🎰\nPlace your bet on a color:\n> .gamble-red <amount>\n> .gamble-green <amount>\n> .gamble-blue <amount>\n> .gamble-black <amount>'   , mentions: [sender] });
            }
            else if (command.startsWith('gamble-')) {
                const color = command.slice(7).toLowerCase();
                if (!['red','green','blue','black'].includes(color)) {
                    await sock.sendMessage(from, { text: 'Invalid color. Choose: red, green, blue, black.'   , mentions: [sender] }); continue;
                }
                const amt = parseInt(args[0]);
                if (!user || isNaN(amt) || amt <= 0 || user.wallet < amt) {
                    await sock.sendMessage(from, { text: 'Invalid amount or insufficient funds.'   , mentions: [sender] }); continue;
                }
                const roll = Math.random();
                let outcome, multiplier;
                if (roll < 0.10) { outcome = 'JACKPOT'; multiplier = 50; }
                else if (roll < 0.30) { outcome = 'WIN'; multiplier = 5; }
                else if (roll < 0.70) { outcome = 'BREAK EVEN'; multiplier = 0; }
                else { outcome = 'LOSS'; multiplier = -12; }
                user.wallet += amt * multiplier;
                saveDb();
                const card = generateGambleCard(user, color, outcome, multiplier, amt);
                await sock.sendMessage(from, { image: card, caption: `🎰 **CURSED CASINO** 🎰\nColor: ${color.toUpperCase()}\nOutcome: ${outcome}\nMultiplier: x${multiplier}\nNet: ${amt * multiplier >= 0 ? '+' : ''}${amt * multiplier} K-Coins`, mentions: [sender] });
            }

            else if (command === 'villages' || command === 'v') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                ensureWorld();
                let msg = '🏘️ *VILLAGES & CLANS*\n';
                for (const [id, v] of Object.entries(db.villages)) {
                    msg += `\n• ${v.name} — Pop ${fmtNum(v.population)} | Wealth ${fmtNum(v.wealth)}\n  Occupier: ${v.clan || 'None'} ${v.rebellion ? '⚠️ REBELLION' : ''}${v.mission ? ' | 📜 Mission open' : ''}${v.liberated ? ' | 🛡️ Liberated ' + v.liberated : ''}\n`;
                }
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

            else if (command === 'v-m') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                ensureWorld();
                const list = Object.entries(db.villages).filter(([id, v]) => v.mission);
                if (!list.length) {
                    await sock.sendMessage(from, { text: '📭 No villager missions available right now. Check back soon — clans are always causing trouble.', mentions: [sender] });
                    continue;
                }
                let msg = '📜 *VILLAGER MISSIONS* (use .v-m-<number> to accept)\n';
                list.forEach(([id, v], i) => {
                    msg += `\n${i + 1}. [${v.name}] ${v.mission.title}\n   Class: ${v.mission.class || 'C'} | Danger ${v.mission.danger}/5 | Reward ${fmtNum(v.mission.reward)} K-Coins | XP: ${fmtNum(v.mission.rewardXp)}\n   ${v.mission.desc}\n`;
                });
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

            else if (command.startsWith('v-m-')) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); continue; }
                ensureWorld();
                const n = parseInt(command.slice(4)) - 1;
                const list = Object.entries(db.villages).filter(([id, v]) => v.mission);
                if (isNaN(n) || !list[n]) {
                    await sock.sendMessage(from, { text: 'Invalid mission number. Use .v-m to list.', mentions: [sender] });
                    continue;
                }
                const [vid, v] = list[n];
                const missionClass = v.mission.class || 'C';
                const enemyGrade = v.mission.enemyGrade ?? 4;
                const enemyMult = v.mission.enemyMult ?? 1.0;
                const base = CURSE_GRADE_STATS[enemyGrade] || CURSE_GRADE_STATS[4];
                const scale = 1 + (user.level - 1) * 0.05;
                const hp = Math.max(15, Math.floor(base.hp * enemyMult * scale));
                const atk = Math.max(1, Math.floor(base.atk * enemyMult * scale));
                const member = { id:'enforcer', name:`${v.mission.clan} Enforcer (${missionClass})`, special: missionClass === 'SSS' || missionClass === 'SS', grade: enemyGrade };
                const enemy = {
                    name: member.name,
                    grade: enemyGrade,
                    stats: { HP: hp, Max_HP: hp, CE: base.ce, Max_CE: base.ce, Output: 1, Refinement: 10 },
                    atk: atk,
                    originalMaxHP: hp,
                    technique: 'Village Enemy',
                    canDomain: missionClass === 'SSS' || missionClass === 'SS',
                    domainChance: missionClass === 'SSS' ? 0.35 : missionClass === 'SS' ? 0.25 : 0.12,
                    skills: {}
                };
                db.combats[sender] = { player: user, enemy, round: 1, cultFight: false, missionFight: true, villageId: vid, missionClass, missionRewardGold: v.mission.reward, missionRewardXp: v.mission.rewardXp, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, host: sender, participants: [sender] };
                if (Math.random() < 0.35) {
                    const npc = getRandomSorcererNpc();
                    if (npc && npc.villageId === vid) {
                        db.combats[sender].tagTeamNpc = npc;
                        db.combats[sender].tagTeamActive = false;
                        const npcName = npc.name || 'a sorcerer';
                        try {
                            await sock.sendMessage(from, { text: `🤝 *SORCERER ENCOUNTER!*\n${npcName} is also on a mission to protect ${v.name}!\nType *.tag-team* to team up with them and fight together!\nIf you succeed, you'll earn the "Besto Friendo" achievement.`, mentions: [sender] });
                        } catch {}
                    }
                }
                saveDb();
                await sock.sendMessage(from, { text: `📜 *MISSION ACCEPTED* — ${v.mission.title}\nVillage: ${v.name}\nClass: ${missionClass}\nEnemy: ${enemy.name} (HP ${enemy.stats.Max_HP} | ATK ${enemy.atk})\n───\n*Type .attack to begin!*\n👁️ Intent: ${enemyIntentHint(db.combats[sender].enemyIntent)}`, mentions: [sender] });
            }

             else if (command === 'corrupt') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const c = user.corruption || 0;
                 const tier = c >= 70 ? '💀 CORRUPTED' : c >= 40 ? '🌑 Tainted' : c >= 15 ? '🌫️ Suspect' : '⚪ Clean';
                  await sock.sendMessage(from, { text: `🩸 *CORRUPTION*: ${c}/100 — ${tier}\nCleanse corruption by completing villager missions.`, mentions: [sender] });
             }
             else if (command === 'sanity') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const s = user.sanity ?? 100;
                 const tier = s <= 0 ? '😱 PANIC' : s < 20 ? '💀 CRITICAL' : s < 40 ? '⚠️ LOW' : s < 70 ? '🌫️ FRAGILE' : '✅ STABLE';
                 await sock.sendMessage(from, { text: `🧠 *SANITY*: ${s}% — ${tier}\n${s <= 0 ? 'You are in a state of absolute panic! All incoming damage +50%, evasion = 0.' : s < 40 ? 'Hallucinations may cause you to miss turns or attack phantoms.' : 'Keep your mind sharp in the Dark Continent.'}`, mentions: [sender] });
             }
             else if (command === 'stance') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const st = user.stance ?? 100;
                 const broken = user.stanceBroken;
                 await sock.sendMessage(from, { text: `🛡️ *STANCE*: ${st}%${broken ? ' — BROKEN!' : ''}\n${broken ? 'Your stance is broken! High-tier skills are cancelled for ' + (user.stanceBreakTurns || 0) + ' more turns.' : 'Take heavy physical damage to break your stance and interrupt enemy charged skills.'}`, mentions: [sender] });
             }

              else if (command === 'cg') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); continue; }
                 if (db.cullingGame?.active && db.cullingGame.players[sender]) {
                     await sock.sendMessage(from, { text: buildCgStatus(sender), mentions: [sender] });
                     continue;
                 }
                 if (db.cullingGame?.active && !db.cullingGame.players[sender]) {
                     await sock.sendMessage(from, { text: '🌍 *CULLING GAME IN PROGRESS.*\nYou are not yet inside. Ask an active participant to add you, or wait for the next game.', mentions: [sender] }); continue;
                 }
                 const START_COST = 500000000;
                 if ((user.wallet || 0) < START_COST) {
                     await sock.sendMessage(from, { text: `🪙 *CULLING GAME ENTRY FEE*\nYou need *${fmtNum(START_COST)}* K-Coins to start the Culling Game.\nYou have: ${fmtNum(user.wallet || 0)}`, mentions: [sender] });
                     continue;
                 }
                 user.wallet -= START_COST;
                 const colony = CULLING_COLONIES[Math.floor(Math.random() * CULLING_COLONIES.length)];
                   db.cullingGame = { active: true, colony, players: { [sender]: true }, rules: [], startTime: Date.now(), endTime: Date.now() + 2 * 60 * 60 * 1000, kenjakuActive: false, strongestSealed: false, startedBy: sender };
                  startAIRuleGenerator(sock);
                 const allUsers = Object.values(db.users || {}).filter(u => u.registered && u.player_id !== sender);
                 const startPoints = 400;
                 ensureCgPlayer(user);
                 user.cullingGame.colony = colony;
                 user.cullingGame.points = startPoints;
                 user.cullingGame.lastPointChange = Date.now();
                 for (const au of allUsers) {
                     if (!au.player_id) continue;
                     db.cullingGame.players[au.player_id] = true;
                     ensureCgPlayer(au);
                     au.cullingGame.colony = colony;
                     au.cullingGame.points = startPoints;
                     au.cullingGame.lastPointChange = Date.now();
                     try { await sock.sendMessage(au.player_id, { text: `🌍 *CULLING GAME FORCED*\n${user.name || sender} has started the Culling Game!\nYou have been dragged into *${colony}* with ${startPoints} points.\nPVP each other to knock yourselves out!\nUse .cg-status to view your standing.`, mentions: [au.player_id] }); } catch {}
                 }
                 saveDb();
                 await sock.sendMessage(from, { text: `🌍 *CULLING GAME — STARTED*\nColony: *${colony}*\nEntry fee: -${fmtNum(START_COST)} K-Coins\nYou start with *${startPoints}* points.\nAll ${Object.keys(db.cullingGame.players || {}).length} players have been forced into the Culling Game!\n───\n📊 *POINTS*\nPvP knockout: +50\nDefeat enemy: +10\n───\n⚠️ *INACTIVITY DECAY*\nIf your score does not change for 70 minutes, your techniques will be locked and HP/CE halved for 4 hours.\n───\nUse .cg-status to view your standing.`, mentions: [sender] });
             }

            else if (command === 'cg-status') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!db.cullingGame?.active || !db.cullingGame.players[sender]) {
                    await sock.sendMessage(from, { text: 'You are not in an active Culling Game.', mentions: [sender] });
                    continue;
                }
                await sock.sendMessage(from, { text: buildCgStatus(sender), mentions: [sender] });
            }

            else if (command === 'cg-rules') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const cg = db.cullingGame;
                if (!cg?.active) { await sock.sendMessage(from, { text: 'No active Culling Game.', mentions: [sender] }); continue; }
                const p = db.users[sender]?.cullingGame || {};
                const needed = 100 - (p.points || 0);
                let msg = `📜 *CULLING GAME RULES*\nActive patches: ${(cg.rules || []).length}\n`;
                if (needed > 0) msg += `You need ${needed} more points to propose a rule (100 pts required).\n`;
                else msg += `You have enough points to propose a rule! Use .cg-rule <proposal>\n`;
                if ((cg.rules || []).length) {
                    msg += `\nCurrent rules:\n`;
                    cg.rules.forEach((r, i) => { msg += `${i + 1}. ${r}\n`; });
                }
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

             else if (command.startsWith('cg-rule')) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const cg = db.cullingGame;
                 if (!cg?.active) { await sock.sendMessage(from, { text: 'No active Culling Game.', mentions: [sender] }); continue; }
                 ensureCgPlayer(user);
                 const p = user.cullingGame;
                 if ((p.points || 0) < 100) { await sock.sendMessage(from, { text: `You need 100 points to propose a rule. You have ${p.points || 0}.`, mentions: [sender] }); continue; }
                 const proposal = (args.join(' ') || '').trim();
                 if (!proposal) { await sock.sendMessage(from, { text: 'Usage: .cg-rule <proposal>', mentions: [sender] }); continue; }
                 const blocked = ['delete', 'ban', 'grant admin', 'give points', 'transfer ownership'];
                 if (blocked.some(b => proposal.toLowerCase().includes(b))) {
                     await sock.sendMessage(from, { text: '⚠️ Rule rejected: it violates server integrity.', mentions: [sender] });
                     continue;
                 }
                 p.points -= 100;
                 cg.rules = cg.rules || [];
                 cg.rules.push(proposal);
                 saveDb();
                 broadcastAllGroups(sock, `📜 *NEW CULLING GAME RULE*\nProposed by ${user.name || sender}:\n"${proposal}"\nAll colonies must obey.`);
                 await sock.sendMessage(from, { text: `✅ Rule added! 100 points spent.`, mentions: [sender] });
             }

             else if (command === 'cg-ai') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const cg = db.cullingGame;
                 if (!cg?.active) { await sock.sendMessage(from, { text: 'No active Culling Game.', mentions: [sender] }); continue; }
                 const rule = generateAIRule();
                 cg.rules = cg.rules || [];
                 if (cg.rules.length >= 10) cg.rules.shift();
                 cg.rules.push(rule);
                 saveDb();
                 broadcastAllGroups(sock, `🤖 *AI RULE GENERATOR*\n\nA new rule has been auto-generated:\n"${rule}"\n\nAll colonies must adapt.`);
                 await sock.sendMessage(from, { text: `🤖 *AI Rule Generated*\n"${rule}"`, mentions: [sender] });
             }

             else if (command === 'cg-leave') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const cg = db.cullingGame;
                 if (!cg?.active || !cg.players[sender]) { await sock.sendMessage(from, { text: 'You are not in an active Culling Game.', mentions: [sender] }); continue; }
                 if ((user.cullingGame?.points || 0) < 200) { await sock.sendMessage(from, { text: 'You need 200 points to safely exit a colony.', mentions: [sender] }); continue; }
                 user.cullingGame.points -= 200;
                 delete cg.players[sender];
                 user.current_node = 'Tokyo Jujutsu High Hub';
                 saveDb();
                 await sock.sendMessage(from, { text: '🚪 *EXITED CULLING GAME*\n-200 points. You have returned to Tokyo Jujutsu High Hub.', mentions: [sender] });
             }

             else if (command === 'k-ch') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); continue; }
                 if (db.cullingGame?.active) { await sock.sendMessage(from, { text: '⚔️ *KENJAKU CHALLENGE*\nYou cannot challenge Kenjaku while the Culling Game is active. Wait for it to end!', mentions: [sender] }); continue; }
                 if (db.sukuna?.active) { await sock.sendMessage(from, { text: '👹 *SUKUNA IS ACTIVE.* You cannot challenge Kenjaku while Sukuna rampages.', mentions: [sender] }); continue; }
                 const grade = getEffectiveGrade(user);
                 const base = CURSE_GRADE_STATS[0];
                 const scale = 1 + (user.level - 1) * 0.05;
                 const hp = Math.max(15, Math.floor(base.hp * 3 * scale));
                 const atk = Math.max(1, Math.floor(base.atk * 2.5 * scale));
                 const enemy = {
                     name: 'Kenjaku',
                     grade: 0,
                     stats: { HP: hp, Max_HP: hp, CE: 9999, Max_CE: 9999, Output: 1, Refinement: 10 },
                     atk: atk,
                     originalMaxHP: hp,
                     technique: 'Brain Transplantation',
                     canDomain: true,
                     domainChance: 0.25,
                     skills: {
                         brain_transplant: { name: 'Brain Transplant', cost: 0, damage: Math.floor(atk * 1.5), effect: 'STEAL_CE' },
                         curse_manipulation: { name: 'Curse Manipulation', cost: 0, damage: Math.floor(atk * 2), effect: 'SUMMON_CURSE' },
                         domain_expansion: { name: 'Domain Expansion: Womb Profusion', cost: 0, damage: Math.floor(atk * 3), effect: 'DOMAIN' }
                     }
                 };
                 db.combats[sender] = { player: user, enemy, round: 1, cultFight: false, missionFight: false, kenjakuFight: true, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, host: sender, participants: [sender] };
                 saveDb();
                 await sock.sendMessage(from, { text: `👁️ *KENJAKU — THE FINAL BOSS*\n\n"You think you can challenge me?\nI am the mastermind behind the Culling Game.\nYour strongest sorcerers have fallen before me.\nLet's see if you are any different."\n\n⚔️ *KENJAKU*\n📈 Special Grade | HP: ${hp} | ATK: ${atk}\n🧠 Brain Transplantation | Curse Manipulation\n\n───\n*Type .attack to begin!*`, mentions: [sender] });
             }

            else if (command === 'cg-invite' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const cg = db.cullingGame;
                if (!cg?.active || !cg.players[sender]) { await sock.sendMessage(from, { text: 'You are not in an active Culling Game.', mentions: [sender] }); continue; }
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const targetJid = mentioned[0] || args[0];
                if (!targetJid) { await sock.sendMessage(from, { text: 'Tag a user to invite them into the Culling Game.', mentions: [sender] }); continue; }
                const targetUser = db.users[targetJid];
                if (!targetUser) { await sock.sendMessage(from, { text: 'Target user not found in database.', mentions: [sender] }); continue; }
                if (db.combats[targetJid]) { await sock.sendMessage(from, { text: 'Target is currently in combat.', mentions: [sender] }); continue; }
                cg.players[targetJid] = true;
                ensureCgPlayer(targetUser);
                targetUser.cullingGame.colony = cg.colony;
                targetUser.cullingGame.points = 0;
                targetUser.cullingGame.lastPointChange = Date.now();
                saveDb();
                await sock.sendMessage(from, { text: `🌍 *CULLING GAME INVITE*\n${user.name || sender} has dragged ${targetUser.name || targetJid} into *${cg.colony}*.\nThey are now trapped inside the barrier.`, mentions: [sender] });
            }

            else if (command === 'story') {
                await sock.sendMessage(from, { text: `📖 *THE STORY OF KENNYJAKS*\n\nLong ago, during the time of Sukuna...\n\nNo one alive could match the King of Curses. That was until *He* was born — the man who shifted the balance itself and became the new balance: *Benimaru*.\n\nAfter their cataclysmic fight ended, Benimaru did not simply destroy Sukuna. He split him into *20 fingers* and scattered them across the realm of Kennyjaks. To this day, no one has gathered them all... but that may soon change.\n\nVillages face threats from rogue curses and corrupt clans. Villagers are trafficked like goods. Slaughter becomes routine. Corruption spreads through the land like a plague.\n\n*I am the Will of Benimaru.*\n\nI have scattered you across this realm to train, to grow strong, and to protect the innocent. Defeat the threats that plague this land. Gather the fingers. Stop the revival of the King of Curses.\n\nTrain hard. Master your technique. Bound your summon. Forge your domain.\n\nI wish you luck in your endeavors — and I have faith you will be victorious.\n\nBecause I am *Benimaru*. And I shall guide you to victory.`, mentions: [sender] });
            }

             else if (command === 'menu') {
                const menuText = `╭━━★彡 𝙺𝙴𝙽𝙽𝚈𝙹𝙰𝙺𝚂 彡★━━╮
┃  𖤓 Prefix: .
┃  𖤓 Name: KENNYJAKS
┃  𖤓 Creator: Benimaru
╰━━━━━━━━━━━╯

⚙️ GENERAL ⚙️
┣ ✦ .start
┣ ✦ .reg-curse / .reg-fighter
┣ ✦ .register <name>
┣ ✦ .p / .profile
┣ ✦ .stats
┣ ✦ .tq  (view your techniques)
 ┣ ✦ .lb  (leaderboard)
 ┣ ✦ .players  (view all registered players)
 ┣ ✦ .achievements / .titles
┣ ✦ .story  (the lore of Kennyjaks)
┣ ✦ .menu
┣ ✦ .help
┗━━━━━━━━━━━

  🎴 PROGRESSION 🎴
 ┣ ✦ .t5r  (forge RCT technique)
 ┣ ✦ .prestige  (reset for prestige points — requires level 100)
 ┣ ✦ .missions  (view daily missions)
 ┣ ✦ .claim-missions  (collect daily rewards)
 ┣ ✦ .collections  (view your collections)
 ┣ ✦ .jk / .taunt
 ┣ ✦ .skills  (view your cross-universe skills)
 ┣ ✦ .l-skills  (view ALL skills in the game)
 ┣ ✦ .sk-1 .. .sk-10  (use a skill in battle — PvE, PvP, Sukuna raid)
 ┗━━━━━━━━━━━

 🩸 COMBAT (PvE) 🩸
 ┣ ✦ .spawn-curse / .b-curse
 ┣ ✦ .attack
 ┣ ✦ .technique-1 .. 4  (innate moves)
 ┣ ✦ .technique-5  (RCT forged ability)
 ┣ ✦ .ut-1 .. 4  (alt battle moves)
 ┣ ✦ .wa  (weapon strike)
 ┣ ✦ .guard / .rct
 ┣ ✦ .su  (summon strike)
 ┣ ✦ .domain  (Grade 2+: forge your own with .domain-n <name>)
 ┣ ✦ .domain-n <name>  (forge your Domain)
 ┣ ✦ .bu / .co / .vow / .it / .jd  (loot techniques + Idle Transfiguration + Courtroom Domain)
 ┣ ✦ .bf  (Black Flash attempt)
 ┣ ✦ .gb  (Granité Blast)
 ┣ ✦ .bw  (Boogie Woogie)
 ┣ ✦ .csm  (Maximum: Uzumaki)
 ┣ ✦ .csm-r  (Maximum: Release)
 ┣ ✦ .cm  (Copy Mimicry)
 ┣ ✦ .qk-1 / .qk-2  (Heavenly Restriction quirks)
 ┣ ✦ .jk  (JACKPOT: 6 min infinite HP/CE + permanent RCT unlock)
 ┣ ✦ .fish  (catch fish for healing)
 ┣ ✦ .heal  (requires fish in inventory)
 ┣ ✦ .flee
 ┣ ✦ .b-invite / .b-i-a  (co-op)
 ┗━━━━━━━━━━━

 🥊 PVP DUELS 🥊
 ┣ ✦ .ch <@user>  (challenge)
 ┣ ✦ .ch-a  (accept)
 ┣ ✦ .ch-end  (end the duel)
 ┣ ✦ Moves: .attack .technique-1..5 .sk-1..10 .guard .rct .domain .wa .flee .bu .co .vow .gb .bw .csm .csm-r .cm .it .jd .qk-1 .qk-2 .jk
 ┗━━━━━━━━━━━

 🌍 WORLD 🌍
┣ ✦ .villages / .v  (village & clan status)
┣ ✦ .v-m  (view villager missions)
┣ ✦ .v-m-<number>  (accept a villager mission)
┣ ✦ .corrupt  (view your corruption)
┣ ✦ .map  (all 500 villages)
┣ ✦ .colonise <name>  (clan HOKAGE; 1 village per clan)
┣ ✦ .set-taxes <amt>  (clan HOKAGE; taxes flow to your wallet)
┣ ✦ .de-col  (release your village)
┣ ✦ .v-a  (accept rebellion liberation mission)
┗━━━━━━━━━━━

  🛡️ PRISON REALM 🛡️
 ┣ ✦ .seal <@user>  (seal someone for 24h with Prison Realm)
 ┣ ✦ .unseal <@user>  (release someone you sealed)
 ┗━━━━━━━━━━━

 🌑 DARK CONTINENT 🌑
┣ ✦ .dmap  (view the Dark Continent map)
┣ ✦ .explore <region>  (enter a region)
┣ ✦ .subs  (list sub-regions in current region)
┣ ✦ .sub <name>  (enter a specific sub-region)
┣ ✦ .engage-r  (battle a curse in your current region)
┣ ✦ .leave-region  (exit your current region)
┣ ✦ .move <close|far|melee|range|number>  (adjust combat distance)
┣ ✦ .sanity  (check your sanity level)
┣ ✦ .stance  (check your stance stability)
┣ ✦ .g-k-gojo  (seal Pandora's key)
┗━━━━━━━━━━━

 🎯 CULLING GAME 🎯
┣ ✦ .cg  (enter the Culling Game)
┣ ✦ .cg-status  (view your colony scoreboard)
┣ ✦ .cg-rules  (view active rule patches)
┣ ✦ .cg-rule <proposal>  (spend 100 pts to add a new rule)
 ┣ ✦ .cg-invite <@user>  (drag a player into your colony)
 ┣ ✦ .cg-leave  (exit colony for 200 pts)
 ┣ ✦ .cg-ai  (generate an AI rule)
 ┣ ✦ .k-ch  (challenge Kenjaku after the Culling Game ends)
 ┗━━━━━━━━━━━

🐾 SUMMONS 🐾
┣ ✦ .summon  (activate / dismiss your familiar)
┣ ✦ .summonshop
┣ ✦ .sbuy-<id>  (claim a familiar)
┣ ✦ .su  (command your summon to strike in battle)
┗━━━━━━━━━━━

 🗡️ WEAPONS & SHOP 🗡️
 ┣ ✦ .shops  (cursed tools)
 ┣ ✦ .buyw <id>
 ┣ ✦ .inventory / .equip / .unequip / .upgrade
 ┣ ✦ .weapon-evolve <name>  (evolve a weapon for +50% stats)
 ┣ ✦ .shop-create / .shop-stock / .shop-buy / .shop-info
 ┗━━━━━━━━━━━

💰 ECONOMY 💰
┣ ✦ .daily
┣ ✦ .wallet / .withdraw / .deposit
┣ ✦ .gamble  (shows colors)
┣ ✦ .gamble-red / .gamble-green / .gamble-blue / .gamble-black <amt>
┗━━━━━━━━━━━

🗺️ WORLD & SUKUNA 🗺️
┣ ✦ .dungeon <id> / .dungeon-next / .dungeon-leave
┣ ✦ .quests  (post global trivia; answer with .q-<answer>)
┣ ✦ .search  (hunt scattered Sukuna fingers)
┣ ✦ .sukuna  (finger status / raid info)
┣ ✦ .accept-s  (join an active Sukuna raid)
┗━━━━━━━━━━━

 🏯 GUILD & CLAN 🏯
 ┣ ✦ .guild / .guild-create / .guild-invite / .guild-leave
 ┣ ✦ .clan-create / .clan-join / .leave-clan / .clan / .l-clan / .poorest-clan
 ┣ ✦ .clan-donate <amt>  (donate to clan bank/XP)
 ┣ ✦ .clan-buff <name>  (HOKAGE: activate clan buff)
 ┣ ✦ .clan-boss  (HOKAGE: summon clan boss)
 ┗━━━━━━━━━━━

🏚️ VILLAGES & REBELLIONS 🏚️
┣ ✦ .map  (all 500 villages: population & wealth)
┣ ✦ .villages  (list colonised villages)
┣ ✦ .colonise <name>  (clan HOKAGE; 1 village per clan)
┣ ✦ .set-taxes <amt>  (clan HOKAGE; taxes flow to your wallet)
┣ ✦ .de-col  (release your village)
┣ ✦ .v-a  (accept a rebellion liberation mission)
┗━━━━━━━━━━━

🛡️ MODERATION (mods/owner) 🛡️
┣ ✦ .addmod / .delmod
┣ ✦ .reset  (wipe a user to level 1; archives their loot & summons)
┣ ✦ .sres <summon id> [@user]  (restore a bought summon + pre-reset loot/summons)
┣ ✦ .kick / .antiban / .approve / .leave
┣ ✦ .give-xp / .give-g / .give-gr / .give-l / .give-loot / .give-hr
┣ ✦ .give-skill <skill name> [@user]  (grant a cross-universe skill)
┣ ✦ .sf-r (scatter all 20 fingers) / .sf-g-all (get all 20) / .sf-give <@user> / .loot-r <@user> / .rem-loot [@user]
┣ ✦ .spawn-sukuna (force raid) / .end-sukuna (banish) / .cg-end (terminate all Culling Games)
┣ ✦ .reset-a  (mod-only: reset ALL users, clear all state, return summons to shop)
┗━━━━━━━━━━━

creator is Benimaru`;
                let menuBuf = null;
                try { menuBuf = fs.readFileSync(path.join(__dirname, 'menu.jpeg')); } catch {}
                if (menuBuf) {
                    await sock.sendMessage(from, { image: menuBuf, caption: '📜 *KENNYJAKS COMMAND MENU*', mentions: [sender] });
                    await sock.sendMessage(from, { text: menuText, mentions: [sender] });
                } else {
                    await sock.sendMessage(from, { text: menuText, mentions: [sender] });
                }
            }

            else if (command === 'i2s') {
                const stickerName = args.join(' ') || 'sticker';
                const src = sourceImageMsg ? getImageFromMessage(sourceImageMsg) : null;
                if (!src) { await sock.sendMessage(from, { text: '📎 Reply to an image or sticker with `.i2s <name>` to convert it.', mentions: [sender] }); continue; }
                try {
                    const imgBuffer = await downloadMediaMessage(src.message, 'buffer');
                    if (!imgBuffer || imgBuffer.length === 0) { await sock.sendMessage(from, { text: '⚠️ Failed to read image.', mentions: [sender] }); continue; }
                    const webpBuf = await sharp(imgBuffer).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
                    await sock.sendMessage(from, { sticker: webpBuf, accessibilityLabel: stickerName });
                } catch (err) {
                    await sock.sendMessage(from, { text: `⚠️ Sticker conversion failed: ${err.message}`, mentions: [sender] });
                }
                continue;
            }

            else if (command === 'take') {
                const newName = args.join(' ');
                if (!newName) { await sock.sendMessage(from, { text: 'Usage: reply to a sticker with `.take <new_name>`', mentions: [sender] }); continue; }
                const src = sourceImageMsg ? getImageFromMessage(sourceImageMsg) : null;
                if (!src || src.type !== 'sticker') { await sock.sendMessage(from, { text: '📎 Reply to a sticker with `.take <new_name>` to rename it.', mentions: [sender] }); continue; }
                try {
                    const stickerBuf = await downloadMediaMessage(src.message, 'buffer');
                    if (!stickerBuf || stickerBuf.length === 0) { await sock.sendMessage(from, { text: '⚠️ Failed to read sticker.', mentions: [sender] }); continue; }
                    await sock.sendMessage(from, { sticker: stickerBuf, accessibilityLabel: newName });
                } catch (err) {
                    await sock.sendMessage(from, { text: `⚠️ Failed to rename sticker: ${err.message}`, mentions: [sender] });
                }
                continue;
            }

              else if (command === 'help') {
                  await sock.sendMessage(from, { text: `╭━━★彡 𝙺𝙴𝙽𝙽𝚈𝙹𝙰𝙺𝚂 : 𝙶𝚄𝙸𝙳𝙴 彡★━━╮
┃  Creator: benimaru
╰━━━━━━━━━━━━━╯

𝙺𝙴𝙽𝙽𝚈𝙹𝙰𝙺𝚂 is a Jujutsu Kaisen open-world RPG on WhatsApp.
Grow from Grade 4 to Special Grade, master a cursed technique,
collect cursed tools, and duel other sorcerers.

▶️ GETTING STARTED
1. .start then pick .reg-curse or .reg-fighter
2. .register <name> to set your display name
3. .daily to claim 1000 gold
4. .p to view your identity card

🌑 DARK CONTINENT
- .dmap renders the 100-region map (Fog of War may obscure details)
- .explore <region> enters a region — reveals curses, treasure, and environmental hazards
- .subs lists sub-regions in your current region
- .sub <name> enters a specific sub-region
- .engage-r starts combat with a random curse in your current region
- .leave-region exits the region
- .move <close|far|melee|range|number> adjusts combat distance (1-50m)
- .sanity checks your current sanity level
- .stance checks your current stance stability
- Environmental Hazards: Miasma (HP/CE drain), Gravity Inversion (melee miss), Fog of War (scrambled info), etc.
- Sanity System: Stay too long and lose sanity (0% = PANIC: +50% damage taken, 0% evasion)
- Hallucinations below 40% sanity cause random missed turns and false targets
- Stance Break: Taking heavy physical damage breaks your stance (2-turn stun, cancels charged skills)
- Status Interlocking: Water/Ice + Lightning = 2.5x Conductive Loop damage; Bleeding + Poison = Blood-Rot
- Regions rotate every 24 hours — danger levels increase and new hazards spawn

⚔️ FIGHTING CURSES
- .spawn-curse then .b-curse to start a battle
- .attack deals a basic strike; .technique-1..4 use your innate moves (cost CE)
- .guard braces (halves the next hit, +CE); .rct converts CE to HP; .flee escapes
- Watch your CE bar - techniques and domains need it
- Win fights for XP, gold and a chance at loot

 🥊 PVP DUELS
 - .ch <@user> challenges a sorcerer (reply or mention them)
 - they type .ch-a to accept; a turn-by-turn duel begins
 - On your turn use: .attack .technique-1..4 .guard .rct .domain .wa .flee .bu .co .vow .gb .bw .csm .csm-r .cm .it .jd .qk-1 .qk-2 .jk
 - Stronger stats hit harder, but CE + guarding keep it competitive

🗡️ WEAPONS & HEAVENLY RESTRICTION
- .shops lists cursed tools (each 400k-600k gold); .buyw <id> buys one (one per user, auto-equips)
- .wa strikes with your weapon in any battle (base 6 damage)
- Defeat a SPECIAL GRADE curse using ONLY .wa strikes to awaken
  HEAVENLY RESTRICTION: your cursed technique is removed, .wa = 200, .attack = 150

🎯 CULLING GAME
- .cg starts the Culling Game (500M entry fee, all players forced in)
- PvP and curse fights only — eliminated players are kicked out
- Highest points after 2 hours wins
- AI rules auto-generate every 10 minutes
- After the game ends, Kenjaku seals the #1 leaderboard player
- Use .k-ch to challenge Kenjaku!

💡 TIPS
  - .tq shows your techniques, .stats shows raw power
  - .skills and .sk-1..10 use cross-universe abilities; .lb tracks the strongest
  - Use .menu any time to see all commands`, mentions: [sender] });
              }

            else if (command === 'approve') {
                if (!from.endsWith('@g.us')) return;
                const meta = await sock.groupMetadata(from);
                const member = meta.participants.find(p => p.id === args[0]);
                if (!member) { await sock.sendMessage(from, { text: 'Member not found.'   , mentions: [sender] }); }
                if (!db.enabledGroups[from]) db.enabledGroups[from] = [];
                if (!db.enabledGroups[from].includes(member.id.split('@')[0])) db.enabledGroups[from].push(member.id.split('@')[0]);
                saveDb();
            }

            else if (command === 'kick') {
                if (!from.endsWith('@g.us')) return;
                if (!isOwner(sender) && !isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.kick)');
                    continue;
                }
                const meta = await sock.groupMetadata(from);
                const kick = args[0];
                if (!kick) { await sock.sendMessage(from, { text: 'Usage: .kick <jid>'   , mentions: [sender] }); }
                const participant = meta.participants.find(p => p.id === kick);
                if (!participant) { await sock.sendMessage(from, { text: 'Participant not found.'   , mentions: [sender] }); }
                await sock.removeParticipant(from, kick);
                await sock.sendMessage(from, { text: `Kicked ${kick}`   , mentions: [sender] });
            }

            else if (command === 'addmod') {
                if (!isOwner(sender) && !isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.addmod)');
                    continue;
                }
                let targetJid = null;
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                if (!targetJid) { await sock.sendMessage(from, { text: 'Reply to a user or tag them to add as mod.'   , mentions: [sender] }); continue; }
                if (!mods.includes(targetJid)) {
                    mods.push(targetJid);
                    saveMods();
                    await sock.sendMessage(from, { text: `✅ Added ${targetJid} as mod.`   , mentions: [sender] });
                } else {
                    await sock.sendMessage(from, { text: 'User is already a mod.'   , mentions: [sender] });
                }
            }

            else if (command === 'delmod') {
                if (!isOwner(sender) && !isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.delmod)');
                    continue;
                }
                let targetJid = null;
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                if (!targetJid) { await sock.sendMessage(from, { text: 'Reply to a user or tag them to remove mod status.'   , mentions: [sender] }); continue; }
                if (mods.includes(targetJid)) {
                    mods = mods.filter(m => !sameJid(m, targetJid));
                    saveMods();
                    await sock.sendMessage(from, { text: `✅ Removed ${targetJid} from mod status.`   , mentions: [sender] });
                } else {
                    await sock.sendMessage(from, { text: 'User is not a mod.'   , mentions: [sender] });
                }
            }

            else if (command === 'reset') {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.reset)');
                    continue;
                }
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                let targetJid = null;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                else targetJid = sender;
                const targetUser = db.users[targetJid];
                if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                // Archive the user's loot, summons, weapons and fingers BEFORE wiping,
                // so a moderator can restore them later with .sres if the reset was a mistake.
                db.restoreArchive = db.restoreArchive || {};
                db.restoreArchive[targetJid] = {
                    archivedAt: Date.now(),
                    name: targetUser.name || targetJid.split('@')[0],
                    loots: Array.isArray(targetUser.loots) ? [...targetUser.loots] : [],
                    ownedSummons: Array.isArray(targetUser.ownedSummons) ? [...targetUser.ownedSummons] : [],
                    weapons_owned: Array.isArray(targetUser.weapons_owned) ? [...targetUser.weapons_owned] : [],
                    fingers: Array.isArray(targetUser.fingers) ? [...targetUser.fingers] : [],
                    summon: targetUser.summon ? JSON.parse(JSON.stringify(targetUser.summon)) : null
                };
                const alignment = targetUser.alignment === 'Curse User' ? 'Curse' : (targetUser.alignment || 'Sorcerer');
                initPlayer(targetJid, alignment, targetUser.innate_technique_id);
                await sock.sendMessage(from, { text: `♻️ Reset ${targetJid} to a fresh level 1 ${alignment}. Their loot and summons have been archived and can be restored with .sres. Mod status is preserved.`, mentions: [sender] });
                continue;
            }

            else if (command === 'sres' && args[0]) {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.sres)');
                    continue;
                }
                const id = parseInt(args[0]);
                const item = SUMMON_SHOP.find(s => s.id === id);
                if (!item) { await sock.sendMessage(from, { text: 'Invalid summon id. Use .summonshop to see available ids.', mentions: [sender] }); continue; }
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                let targetJid = null;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                else targetJid = sender;
                const targetUser = db.users[targetJid];
                if (!targetUser) { await sock.sendMessage(from, { text: 'Target user not found in database.', mentions: [sender] }); continue; }
                // 1) Re-grant the bought summon to the target as their single familiar.
                // Any other summon they currently hold is released back to the shop.
                const prev = (targetUser.ownedSummons || []).slice();
                for (const oid of prev) releaseSummonToShop(targetUser, oid);
                setSingleSummon(targetUser, id, item);
                let restored = `🐾 *SUMMON RESTORED*\n*${item.name}* (ID ${id}) has been re-bound to ${targetUser.name || targetJid}.`;
                // 2) If this user was reset, restore their loot / weapons / fingers (summons stay single).
                db.restoreArchive = db.restoreArchive || {};
                const arch = db.restoreArchive[targetJid];
                if (arch) {
                    targetUser.loots = Array.from(new Set([...(targetUser.loots || []), ...arch.loots]));
                    targetUser.weapons_owned = Array.from(new Set([...(targetUser.weapons_owned || []), ...arch.weapons_owned]));
                    targetUser.fingers = Array.from(new Set([...(targetUser.fingers || []), ...arch.fingers]));
                    // Single-summon rule: only the restored id is kept; any extras from the archive return to the shop.
                    for (const oid of (arch.ownedSummons || [])) {
                        if (oid !== id) {
                            if (db.soldSummons && db.soldSummons[oid] === targetJid) delete db.soldSummons[oid];
                        }
                    }
                    delete db.restoreArchive[targetJid];
                    restored += `\n\n🗃️ *PRE-RESET ARCHIVE RESTORED for ${arch.name}:*\n• Loot: ${arch.loots.length} item(s)\n• Weapons: ${arch.weapons_owned.length}\n• Fingers: ${arch.fingers.length}\n• Summon: ${item.name} (single familiar bound)\nAll previously held loot has been returned; summons are limited to one.`;
                }
                saveDb();
                await sock.sendMessage(from, { text: restored, mentions: [sender] });
                continue;
            }

            else if (command === 'spawn-sukuna') {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.spawn-sukuna)');
                    continue;
                }
                if (db.sukuna?.active) { await sock.sendMessage(from, { text: '⚠️ SUKUNA IS ALREADY ACTIVE.', mentions: [sender] }); continue; }
                spawnSukuna(sock, sender, user?.name || sender.split('@')[0]);
                await sock.sendMessage(from, { text: '👹 *SUKUNA FORCE-SPAWNED BY A MODERATOR.*', mentions: [sender] });
            }

             else if (command === 'end-sukuna') {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.end-sukuna)');
                     continue;
                 }
                 if (!db.sukuna?.active) { await sock.sendMessage(from, { text: '⚠️ NO ACTIVE SUKUNA RAID TO END.', mentions: [sender] }); continue; }
                 db.sukuna = null;
                 db.scatteredFingers = 20;
                 db.sukunaFingers = null; ensureFingerState();
                 saveDb();
                 broadcastAllGroups(sock, '*SUKUNA HAS BEEN BANISHED BY THE MODERATORS.*\nTHE 20 FINGERS HAVE BEEN SCATTERED ACROSS THE REALM — USE .search TO FIND THEM.');
             }

                else if (command === 'end') {
                  if (!isMod(sender)) {
                      const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                      await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                      if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.end)');
                      continue;
                  }

                  let cullingEnded = false;
                  let prisonFreed = 0;

                  // End Culling Game if active
                  if (db.cullingGame?.active) {
                      const players = Object.keys(db.cullingGame.players || {});
                      db.cullingGame = { active: false, colony: null, players: {}, rules: [], startTime: null, endTime: null, kenjakuActive: false, strongestSealed: false, kenjakuPrevented: true };
                      players.forEach(jid => {
                          const u = db.users[jid];
                          if (u?.cullingGame) {
                              u.cullingGame = { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: Date.now(), techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null };
                          }
                      });
                      if (aiRuleTimer) { clearInterval(aiRuleTimer); aiRuleTimer = null; }
                      cullingEnded = true;
                  }

                  // Free all users in Prison Realm
                  const sealedUsers = Object.values(db.users || {}).filter(u => u.prisonRealm && Date.now() < (u.prisonRealm.releasedAt || 0));
                  for (const su of sealedUsers) {
                      su.prisonRealm = null;
                      su.fingers = [];
                      prisonFreed++;
                  }

                  saveDb();

                  if (cullingEnded && prisonFreed > 0) {
                      await sock.sendMessage(from, { text: `🛑 *MODERATOR INTERVENTION*\n\n✅ Culling Game ended.\n✅ ${prisonFreed} user(s) freed from Prison Realm.\n✅ Kenjaku will not seal anyone.\n\nAll systems reset.`, mentions: [sender] });
                  } else if (cullingEnded) {
                      await sock.sendMessage(from, { text: `🛑 *MODERATOR INTERVENTION*\n\n✅ Culling Game ended.\n✅ Kenjaku will not seal anyone.\n\nAll systems reset.`, mentions: [sender] });
                  } else if (prisonFreed > 0) {
                      await sock.sendMessage(from, { text: `🔓 *PRISON REALM PURGE*\n\n${prisonFreed} user(s) have been freed from the Prison Realm.\nTheir seals have been broken.`, mentions: [sender] });
                  } else {
                      await sock.sendMessage(from, { text: '⚠️ Nothing to end. No active Culling Game and no users in Prison Realm.', mentions: [sender] });
                  }
              }

              else if (command === 'cg-end') {
                    const isGameStarter = db.cullingGame?.startedBy === sender;
                    if (!isMod(sender) && !isGameStarter) {
                        const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                        await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                        if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.cg-end)');
                        continue;
                    }
                    if (!db.cullingGame?.active) { await sock.sendMessage(from, { text: '⚠️ NO ACTIVE CULLING GAME TO END.', mentions: [sender] }); continue; }
                    const players = Object.keys(db.cullingGame.players || {});
                    const strongestJid = db.cullingGame.strongestJid;
                    db.cullingGame = { active: false, colony: null, players: {}, rules: [], startTime: null, endTime: null, kenjakuActive: false, strongestSealed: false, kenjakuPrevented: true };
                    players.forEach(jid => {
                        const u = db.users[jid];
                        if (u?.cullingGame) {
                            u.cullingGame = { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: Date.now(), techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null };
                        }
                    });
                    if (strongestJid) {
                        const su = db.users[strongestJid];
                        if (su) {
                            su.prisonRealm = null;
                            su.fingers = [];
                        }
                    }
                     if (aiRuleTimer) { clearInterval(aiRuleTimer); aiRuleTimer = null; }

                     // Free all users in Prison Realm
                     const sealedUsers = Object.values(db.users || {}).filter(u => u.prisonRealm && Date.now() < (u.prisonRealm.releasedAt || 0));
                     for (const su of sealedUsers) {
                         su.prisonRealm = null;
                         su.fingers = [];
                     }

                     saveDb();
                     const freedCount = sealedUsers.length;
                     await sock.sendMessage(from, { text: `🌍 *CULLING GAME TERMINATED*\nAll ${players.length} player(s) have been removed from the barrier.\n${freedCount > 0 ? `✅ ${freedCount} user(s) freed from Prison Realm.\n` : ''}✅ Kenjaku will not seal anyone.\nThe Culling Game has been ended by ${isMod(sender) ? 'the moderators' : 'the game starter'}.`, mentions: [sender] });
                }

             else if (command === 'give-xp' && args[0]) {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-xp)');
                     continue;
                 }
                 const amount = parseSafeInt(args[0], 1, 10000000) || parseInt(args[0]);
                 if (isNaN(amount) || amount <= 0) { await sock.sendMessage(from, { text: 'Invalid amount.'   , mentions: [sender] }); continue; }
                 let targetJid = sender;
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 if (replyParticipant) targetJid = replyParticipant;
                 else if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                 const targetUser = findUserByJid(targetJid) || findUserByJid(sender);
                 if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.'   , mentions: [sender] }); continue; }
                  targetUser.xp += amount;
                  checkLevelUp(targetUser);
                  saveDb();
                  await sock.sendMessage(from, { text: `✅ Gave ${amount} XP to ${targetUser.name || targetJid}.`   , mentions: [sender] });
             }

             else if (command === 'give-g' && args[0]) {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-g)');
                     continue;
                 }
                 const amount = parseSafeInt(args[0], 1, 100000000) || parseInt(args[0]);
                 if (isNaN(amount) || amount <= 0) { await sock.sendMessage(from, { text: 'Invalid amount.'   , mentions: [sender] }); continue; }
                 let targetJid = sender;
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 if (replyParticipant) targetJid = replyParticipant;
                 else if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                 const targetUser = findUserByJid(targetJid) || findUserByJid(sender);
                 if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.'   , mentions: [sender] }); continue; }
                  targetUser.wallet = (targetUser.wallet || 0) + amount;
                  saveDb();
                 await sock.sendMessage(from, { text: `✅ Gave ${amount} gold coins to ${targetUser.name || targetJid}.`   , mentions: [sender] });
             }

            else if (command === 'give-gr' && args[0]) {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-gr)');
                    continue;
                }
                const grade = parseGradeArg(args[0]);
                if (grade === null) { await sock.sendMessage(from, { text: 'Invalid grade. Use: special, 0, 1, 2, 3, 4 (special = Special Grade).'   , mentions: [sender] }); continue; }
                let targetJid = sender;
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                const targetUser = db.users[targetJid] || db.users[sender];
                if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.'   , mentions: [sender] }); continue; }
                 const newLevel = Math.max(targetUser.level || 1, gradeBandStart(grade));
                 targetUser.level = newLevel;
                 targetUser.grade = grade;
                 targetUser.xp = 0;
                 targetUser.xp_needed = 30000 + 1000 * Math.pow(newLevel, 2);
                 targetUser.stats.HP = targetUser.stats.Max_HP;
                 targetUser.stats.CE = targetUser.stats.Max_CE;
                 saveDb();
                await sock.sendMessage(from, { text: `✅ Set ${targetUser.name || targetJid}'s grade to *${GRADE_NAMES[grade]}* (level aligned to ${newLevel}). Their summon will now fight at this grade's power.`   , mentions: [sender] });
            }

            else if (command === 'give-l' && args[0]) {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-l)');
                    continue;
                }
                const level = parseInt(args[0]);
                if (isNaN(level) || level < 1 || level > MAX_LEVEL) { await sock.sendMessage(from, { text: `Invalid level. Must be between 1 and ${MAX_LEVEL}.`   , mentions: [sender] }); continue; }
                let targetJid = sender;
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                const targetUser = db.users[targetJid] || db.users[sender];
                if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.'   , mentions: [sender] }); continue; }
                 targetUser.level = level;
                 targetUser.xp = 0;
                 targetUser.xp_needed = 30000 + 1000 * Math.pow(level, 2);
                 targetUser.grade = calculateGrade(level);
                 targetUser.stats.HP = targetUser.stats.Max_HP;
                 targetUser.stats.CE = targetUser.stats.Max_CE;
                 saveDb();
                 await sock.sendMessage(from, { text: `✅ Set ${targetUser.name || targetJid}'s level to ${level} (grade now *${GRADE_NAMES[targetUser.grade]}*). Their summon will now fight at this grade's power.`   , mentions: [sender] });
            }

             else if (command === 'give-loot' && args[0]) {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.'   , mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-loot)');
                    continue;
                }
                const loot = resolveLootByName(args.join(' '));
                if (!loot) { await sock.sendMessage(from, { text: 'Unknown loot. Available: ' + Object.values(LOOTS).map(l => l.name).join(', ')   , mentions: [sender] }); continue; }
                let targetJid = sender;
                const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                if (replyParticipant) targetJid = replyParticipant;
                else if (mentioned.length > 0) targetJid = mentioned[0];
                else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                const targetUser = db.users[targetJid] || db.users[sender];
                if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.'   , mentions: [sender] }); continue; }
                 const granted = grantLoot(targetUser, loot.id, false);
                 saveDb();
                 await sock.sendMessage(from, { text: `✅ Gave *${granted.name}* to ${targetUser.name || targetJid}.${loot.unique ? ' (This is a mod copy — it does NOT leave the global pool, so it can still drop for others.)' : ''}`   , mentions: [sender] });
             }

              else if (command === 'give-hr') {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-hr)');
                     continue;
                 }
                 let targetJid = sender;
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 if (replyParticipant) targetJid = replyParticipant;
                 else if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                 const targetUser = db.users[targetJid] || db.users[sender];
                 if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                 if (targetUser.heavenly_restriction) { await sock.sendMessage(from, { text: '⚡ That user already has Heavenly Restriction.', mentions: [sender] }); continue; }
                   const ok = grantHeavenlyRestriction(targetUser);
                   saveDb();
                   const quirkNames = (targetUser.quirks || []).map(q => q.name).join(', ');
                   await sock.sendMessage(from, { text: `⚡ *HEAVENLY RESTRICTION GRANTED*\n${targetUser.name || targetJid} has been stripped of their innate technique and granted Heavenly Restriction.\n+200 WA Attack | +200 Defense | Techniques: Heavy Slash, Clap Smash, Super Fast Slash, Divine Axe Slash.\n🌀 Quirks: ${quirkNames || 'None (explore Dark Continent to awaken)'}`, mentions: [sender] });
              }

              else if (command === 'give-sp' && args[0]) {
                  if (!isMod(sender)) {
                      const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                      await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                      if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-sp)');
                      continue;
                  }
                  const amt = parseInt(args[0]);
                  if (isNaN(amt) || amt <= 0) { await sock.sendMessage(from, { text: 'Usage: .give-sp <amount> @user', mentions: [sender] }); continue; }
                  let targetJid = sender;
                  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                  const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                  if (replyParticipant) targetJid = replyParticipant;
                  else if (mentioned.length > 0) targetJid = mentioned[0];
                  else if (args[1]) targetJid = args[1].includes('@') ? args[1] : args[1].replace(/[^0-9]/g, '') + '@lid';
                  const targetUser = db.users[targetJid] || db.users[sender];
                  if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                  targetUser.skill_points = (targetUser.skill_points || 0) + amt;
                  saveDb();
                  await sock.sendMessage(from, { text: `✅ Gave *${amt}* skill points to ${targetUser.name || targetJid}. New total: ${targetUser.skill_points}`, mentions: [sender] });
              }

              else if (command === 'rem-hr') {
                  if (!isMod(sender)) {
                      const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                      await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                      if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.rem-hr)');
                      continue;
                  }
                  let targetJid = sender;
                  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                  const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                  if (replyParticipant) targetJid = replyParticipant;
                  else if (mentioned.length > 0) targetJid = mentioned[0];
                  else if (args[0]) targetJid = args[0].includes('@') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@lid';
                  const targetUser = db.users[targetJid] || db.users[sender];
                  if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                  if (!targetUser.heavenly_restriction) { await sock.sendMessage(from, { text: '⚡ That user does not have Heavenly Restriction.', mentions: [sender] }); continue; }
                  targetUser.heavenly_restriction = false;
                  delete targetUser._bonus_attack;
                  delete targetUser._bonus_defense;
                  targetUser.wa_attack = 6;
                  targetUser.quirks = [];
                  targetUser.custom_technique = null;
                  targetUser.unlocked_features = { RCT: false, Domain: false, Simple_Domain: false };
                  const type = targetUser.alignment === 'Curse User' ? 'Curse' : 'Fighter';
                  const randomTech = getRandomTechnique(type);
                  targetUser.innate_technique_id = randomTech;
                  targetUser.skills = INNATE_TECHNIQUES[randomTech]?.moves || {};
                  const moveKeys = Object.keys(targetUser.skills);
                  targetUser.technique_1 = moveKeys[0] || null;
                  targetUser.technique_2 = moveKeys[1] || null;
                  targetUser.technique_3 = moveKeys[2] || null;
                  targetUser.technique_4 = moveKeys[3] || null;
                  recalcStats(targetUser);
                  saveDb();
                  await sock.sendMessage(from, { text: `⚡ *HEAVENLY RESTRICTION REMOVED*\n${targetUser.name || targetJid} has regained their innate technique.\nNew Technique: *${randomTech}*\n🌀 Quirks cleared.`, mentions: [sender] });
              }

             else if (command === 'give-qk' && args[0]) {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-qk)');
                     continue;
                 }
                 const quirkName = args.join(' ').toLowerCase().trim();
                 const quirkEntry = Object.entries(QUIRKS).find(([id, q]) => q.name.toLowerCase() === quirkName || id === quirkName);
                 if (!quirkEntry) { await sock.sendMessage(from, { text: 'Unknown quirk. Use .tq to see valid quirk names.', mentions: [sender] }); continue; }
                 const [, quirk] = quirkEntry;
                 let targetJid = sender;
                 const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                 const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                 if (mentioned.length > 0) targetJid = mentioned[0];
                 else if (replyParticipant) targetJid = replyParticipant;
                 else if (args[args.length - 1].includes('@') || /^\d+$/.test(args[args.length - 1].replace(/[^0-9]/g, ''))) {
                     targetJid = args[args.length - 1].includes('@') ? args[args.length - 1] : args[args.length - 1].replace(/[^0-9]/g, '') + '@lid';
                 }
                 const targetUser = db.users[targetJid];
                 if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                 if (!targetUser.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ Target must be an HR user to receive quirks.', mentions: [sender] }); continue; }
                 if ((targetUser.quirks || []).length >= 2) { await sock.sendMessage(from, { text: 'Target already has 2 quirks (maximum).', mentions: [sender] }); continue; }
                 if (targetUser.quirks?.find(q => q.id === quirk.id)) { await sock.sendMessage(from, { text: 'Target already has that quirk.', mentions: [sender] }); continue; }
                 targetUser.quirks = targetUser.quirks || [];
                 targetUser.quirks.push(quirk);
                 saveDb();
                 await sock.sendMessage(from, { text: `✅ Gave *${quirk.name}* to ${targetUser.name || targetJid}.\n🌀 They now have ${targetUser.quirks.length}/2 quirks.`, mentions: [sender] });
             }

             else if (command === 'sf-r') {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.sf-r)');
                     continue;
                 }
                 db.sukunaFingers = null; ensureFingerState();
                 db.scatteredFingers = 20;
                 saveDb();
                 broadcastAllGroups(sock, '*🔥 A MODERATOR HAS SCATTERED ALL 20 SUKUNA FINGERS ACROSS THE REALM.*\nUSE .search TO HUNT THEM DOWN.');
                 await sock.sendMessage(from, { text: '🔥 *ALL 20 SUKUNA FINGERS SCATTERED.* Users can now find them with .search.', mentions: [sender] });
             }

             else if (command === 'sf-g-all') {
                 if (!isMod(sender)) {
                     const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                     await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                     if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.sf-g-all)');
                     continue;
                 }
                 if (!user) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                 user.fingers = user.fingers || [];
                 const need = Math.max(0, 20 - user.fingers.length);
                 for (let i = 0; i < need; i++) user.fingers.push('mod-all-' + i + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
                 let msg = `🔥 *YOU NOW HOLD ALL 20 SUKUNA FINGERS* (${user.fingers.length} total).`;
                 if (!db.sukuna?.active) {
                     spawnSukuna(sock, sender, user.name || sender.split('@')[0]);
                     msg += `\n⚠️ *ALL 20 FINGERS GATHERED — SUKUNA AWAKENS!*`;
                 }
                 saveDb();
                 await sock.sendMessage(from, { text: msg, mentions: [sender] });
             }

               else if (command === 'loot-r') {
                   if (!isMod(sender)) {
                       const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                       await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                       if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.loot-r)');
                       continue;
                   }
                   const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                   const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                   let targetJid = replyParticipant || (mentioned.length ? mentioned[0] : null);
                   let targetUser;
                   if (targetJid) {
                       targetUser = db.users[targetJid];
                       if (!targetUser) { await sock.sendMessage(from, { text: '🚫 *TAGGED USER NOT FOUND IN DATABASE.*', mentions: [sender] }); continue; }
                   } else {
                       targetJid = sender;
                       targetUser = user;
                       if (!targetUser) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                   }
                   const removed = targetUser.loots ? targetUser.loots.length : 0;
                   targetUser.loots = [];
                   saveDb();
                   await sock.sendMessage(from, { text: `🧹 *LOOT REMOVED* — cleared ${removed} loot item(s) from ${targetUser.name || targetJid}.`, mentions: [sender, targetJid].filter(Boolean) });
               }

               else if (command === 'rem-loot') {
                   if (!isMod(sender)) {
                       const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                       await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                       if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.rem-loot)');
                       continue;
                   }
                   const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                   const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                   let targetJid = replyParticipant || (mentioned.length ? mentioned[0] : null);
                   let targetUser;
                   if (targetJid) {
                       targetUser = db.users[targetJid];
                       if (!targetUser) { await sock.sendMessage(from, { text: '🚫 *TAGGED USER NOT FOUND IN DATABASE.*', mentions: [sender] }); continue; }
                   } else {
                       targetJid = sender;
                       targetUser = user;
                       if (!targetUser) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                   }
                   if (!targetUser.loots || !targetUser.loots.length) {
                       await sock.sendMessage(from, { text: `🧹 *NO LOOT* — ${targetUser.name || targetJid} has no loot to remove.`, mentions: [sender, targetJid].filter(Boolean) });
                       continue;
                   }
                   const removed = [...targetUser.loots];
                   targetUser.loots = [];
                   saveDb();
                   await sock.sendMessage(from, { text: `🧹 *LOOT REMOVED* — cleared ${removed.length} loot item(s) from ${targetUser.name || targetJid}.\nRemoved: ${removed.join(', ')}`, mentions: [sender, targetJid].filter(Boolean) });
               }

               else if (command === 'reset-a') {
                   if (!isMod(sender)) {
                       const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                       await sock.sendMessage(from, { text: '⛔ Mod-only command.', mentions: [sender] });
                       if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.reset-a)');
                       continue;
                   }
                   let resetCount = 0;
                   for (const u of Object.values(db.users)) {
                       if (!u.registered) continue;
                       const alignment = u.alignment === 'Curse User' ? 'Curse' : (u.alignment || 'Sorcerer');
                       initPlayer(u.player_id, alignment, u.innate_technique_id);
                       resetCount++;
                   }
                   db.combats = {};
                   db.pvp = {};
                   db.sukuna = null;
                   db.sukunaFingers = null;
                   ensureFingerState();
                   db.scatteredFingers = 20;
                   for (const u of Object.values(db.users)) {
                       if (u.ownedSummons) {
                           for (const oid of u.ownedSummons) {
                               if (db.soldSummons && db.soldSummons[oid] === (u.player_id || u)) delete db.soldSummons[oid];
                           }
                       }
                       u.ownedSummons = [];
                       u.summon = { active: false, name: 'None', HP: 0, Max_HP: 0, type: 'None' };
                   }
                   if (fs.existsSync(modPath)) {
                       mods = JSON.parse(fs.readFileSync(modPath, 'utf8')).mods || [];
                   }
                   saveDb();
                   await sock.sendMessage(from, { text: `⚠️ *GLOBAL RESET COMPLETE*\n• ${resetCount} users reset to level 1\n• All combats cleared\n• All PvP matches cleared\n• Sukuna raid ended\n• All summons returned to shop\n• Mod list preserved from mod.json`, mentions: [sender] });
               }

              else if (command === 'antiban') {
                if (!isOwner(sender) && !isMod(sender)) { await sock.sendMessage(from, { text: '⛔ Restricted.'   , mentions: [sender] }); continue; }
                const s = sock.antiBanStats ? sock.antiBanStats() : { enabled: false };
                await sock.sendMessage(from, { text: `🛡️ *ANTI-BAN PROTOCOL*\nStatus: ${s.enabled ? 'ACTIVE' : 'DISABLED'}\nMessages queued: ${s.queued}\nSent in last 60s: ${s.perMinute}\nLimits: global gap ${s.limits?.globalMinIntervalMs}ms | per-chat gap ${s.limits?.jidMinIntervalMs}ms | cap ${s.limits?.perMinuteCap}/min | jitter ${s.limits?.jitterMs}ms\nAll outbound messages are paced to mimic human cadence.`, mentions: [sender] }); continue;
            }

              else if (command === 'give-skill' && args[0]) {
                  if (!isMod(sender)) {
                      const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                      await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                      if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.give-skill)');
                      continue;
                  }
                  let skillName = args.join(' ').toLowerCase().trim();
                  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                  const replyParticipant = m.message?.extendedTextMessage?.contextInfo?.participant;
                  let targetJid = replyParticipant || (mentioned.length ? mentioned[0] : null);
                  if (!targetJid && args.length > 1) {
                      const last = args[args.length - 1];
                      if (last.includes('@') || /^\d+$/.test(last.replace(/[^0-9]/g, ''))) {
                          targetJid = last.includes('@') ? last : last.replace(/[^0-9]/g, '') + '@lid';
                          skillName = args.slice(0, -1).join(' ').toLowerCase().trim();
                      }
                  }
                  const skillEntry = Object.entries(CROSS_UNIVERSE_SKILLS).find(([id, s]) => s.name.toLowerCase() === skillName || String(id) === skillName);
                  if (!skillEntry) { await sock.sendMessage(from, { text: 'Unknown skill. Use .l-skills to see all valid skill names.', mentions: [sender] }); continue; }
                  const [skillId, skill] = skillEntry;
                  if (!targetJid) targetJid = sender;
                  const targetUser = db.users[targetJid] || db.users[sender];
                   if (!targetUser) { await sock.sendMessage(from, { text: 'User not found in database.', mentions: [sender] }); continue; }
                   if (targetUser.heavenly_restriction) { await sock.sendMessage(from, { text: '⛓️ *HEAVENLY RESTRICTION:* This user cannot learn skills. They wield quirks instead.', mentions: [sender] }); continue; }
                   if (!db.userSkills) db.userSkills = {};
                  if (!db.userSkills[targetJid]) db.userSkills[targetJid] = [];
                  if (db.userSkills[targetJid].includes(skillId)) { await sock.sendMessage(from, { text: `${targetUser.name || targetJid} already has ${skill.name}.`, mentions: [sender] }); continue; }
                  if (db.userSkills[targetJid].length >= 10) { await sock.sendMessage(from, { text: `${targetUser.name || targetJid} already has 10 skills.`, mentions: [sender] }); continue; }
                  db.userSkills[targetJid].push(skillId);
                  saveDb();
                  await sock.sendMessage(from, { text: `✅ Gave *${skill.name}* to ${targetUser.name || targetJid}.\n📚 They now have ${db.userSkills[targetJid].length}/10 skills.`, mentions: [sender] });
              }

            else if (command === 'unlock-pandora') {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.unlock-pandora)');
                    continue;
                }
                ensureDarkContinent();
                db.darkContinent.pandoraBox = { locked: false, keyFound: true, kingsUnleashed: true, gojoEncountered: false };
                saveDb();
                broadcastAllGroups(sock, '📦 *PANDORA\'S BOX HAS BEEN UNSEALED BY THE MODERATORS.*\nThe 5 Kings of Pandora are now free.');
                await sock.sendMessage(from, { text: '📦 *PANDORA UNLOCKED*\nThe 5 Kings of Pandora have been unleashed.', mentions: [sender] });
            }

            else if (command === 'seal-pandora') {
                if (!isMod(sender)) {
                    const n = recIntrusion(sender, 'mod_bypass', 3).attempts.mod_bypass;
                    await sock.sendMessage(from, { text: '⛔ Unauthorized privilege attempt has been logged.', mentions: [sender] });
                    if (n >= 3) await kickOff(sock, from, sender, 'Privilege escalation attempt (.seal-pandora)');
                    continue;
                }
                ensureDarkContinent();
                db.darkContinent.pandoraBox = { locked: true, keyFound: false, kingsUnleashed: false, gojoEncountered: false };
                db.darkContinent.shards = [];
                while (db.darkContinent.shards.length < 4) {
                    const rid = 1 + Math.floor(Math.random() * 100);
                    if (!db.darkContinent.shards.includes(rid)) db.darkContinent.shards.push(rid);
                }
                saveDb();
                broadcastAllGroups(sock, '🔒 *PANDORA\'S BOX HAS BEEN SEALED BY THE MODERATORS.*\nThe 5 Kings are locked away once more. The shards have been scattered across the Dark Continent.');
                await sock.sendMessage(from, { text: '🔒 *PANDORA SEALED*\nThe 5 Kings are locked away. Shards scattered.', mentions: [sender] });
            }

            else if (command === 'inventory') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                let msg = `🎒 **INVENTORY**\n───\n`;
                if (!user.inventory || user.inventory.length === 0) {
                    msg += 'Empty.\n';
                } else {
                    const grouped = {};
                    user.inventory.forEach(item => {
                        const key = item.name + '|' + item.rarity;
                        if (!grouped[key]) grouped[key] = { ...item, count: 0 };
                        grouped[key].count++;
                    });
                    Object.values(grouped).forEach(item => {
                        msg += `${item.rarityColor || ''} **${item.name}** (${item.rarityName || 'Common'}) x${item.count}\n`;
                        if (item.stats) {
                            Object.entries(item.stats).forEach(([k, v]) => msg += `   > +${v} ${k}\n`);
                        }
                        msg += `\n`;
                    });
                }
                msg += '───\n*Equipped:*\n';
                ['weapon', 'armor', 'accessory', 'relic'].forEach(slot => {
                    const eq = user.equipment?.[slot];
                    if (eq && eq !== 'None') {
                        msg += `${eq.rarityColor || ''} ${slot}: ${eq.name} (${eq.rarityName || 'Common'})\n`;
                        if (eq.stats) Object.entries(eq.stats).forEach(([k, v]) => msg += `   > +${v} ${k}\n`);
                    }
                });
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

             else if (command === 'equip' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const itemName = args.join(' ');
                 const itemIndex = user.inventory.findIndex(i => i.name === itemName);
                 if (itemIndex === -1) { await sock.sendMessage(from, { text: 'Item not found in inventory.'   , mentions: [sender] }); continue; }
                 const item = user.inventory[itemIndex];
                 const slot = item.slot;
                 if (!slot) { await sock.sendMessage(from, { text: 'This item cannot be equipped.'   , mentions: [sender] }); continue; }
                 const current = user.equipment?.[slot];
                 if (current && current !== 'None') {
                     if (!user.inventory.find(i => i.name === current.name)) {
                         user.inventory.push(current);
                     }
                 }
                 user.equipment[slot] = item;
                 user.inventory.splice(itemIndex, 1);
                 saveDb();
                 await sock.sendMessage(from, { text: `⚔️ Equipped ${item.rarityColor || ''} ${item.name} to ${slot}.`   , mentions: [sender] });
             }

             else if (command === 'unequip' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const slot = args[0].toLowerCase();
                 const validSlots = ['weapon', 'armor', 'accessory', 'relic'];
                 if (!validSlots.includes(slot)) { await sock.sendMessage(from, { text: 'Invalid slot. Use: weapon, armor, accessory, relic'   , mentions: [sender] }); continue; }
                 const current = user.equipment?.[slot];
                 if (!current || current === 'None') { await sock.sendMessage(from, { text: 'Nothing equipped in that slot.'   , mentions: [sender] }); continue; }
                 user.inventory.push(current);
                user.equipment[slot] = 'None';
                saveDb();
                await sock.sendMessage(from, { text: `📦 Unequipped ${current.rarityColor || ''} ${current.name} to inventory.`   , mentions: [sender] });
            }

             else if (command === 'upgrade' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const itemName = args.join(' ');
                 const itemIndex = user.inventory.findIndex(i => i.name === itemName);
                 if (itemIndex === -1) { await sock.sendMessage(from, { text: 'Item not found in inventory.'   , mentions: [sender] }); continue; }
                 const item = user.inventory[itemIndex];
                 const cost = 200;
                 if (user.wallet < cost) { await sock.sendMessage(from, { text: `Need ${cost} gold to upgrade.`   , mentions: [sender] }); continue; }
                 user.wallet -= cost;
                 Object.keys(item.stats).forEach(stat => {
                     item.stats[stat] = Math.floor(item.stats[stat] * 1.2);
                 });
                 item.durability = 100;
                 saveDb();
                 await sock.sendMessage(from, { text: `⬆️ Upgraded ${item.rarityColor || ''} ${item.name}! Stats increased by 20%.`   , mentions: [sender] });
             }

             else if (command === 'weapon-evolve' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const itemName = args.join(' ');
                 const itemIndex = user.inventory.findIndex(i => i.name === itemName);
                 if (itemIndex === -1) { await sock.sendMessage(from, { text: 'Item not found in inventory.'   , mentions: [sender] }); continue; }
                 const item = user.inventory[itemIndex];
                 if (item.slot !== 'weapon') { await sock.sendMessage(from, { text: 'Only weapons can be evolved.'   , mentions: [sender] }); continue; }
                 const evolveCost = 5000;
                 if (user.wallet < evolveCost) { await sock.sendMessage(from, { text: `Need ${fmtNum(evolveCost)} K-Coins to evolve this weapon.`   , mentions: [sender] }); continue; }
                 user.wallet -= evolveCost;
                 Object.keys(item.stats).forEach(stat => {
                     item.stats[stat] = Math.floor(item.stats[stat] * 1.5);
                 });
                 item.rarityName = 'Evolved ' + (item.rarityName || 'Common');
                 item.name = 'Evolved ' + item.name;
                 saveDb();
                 await sock.sendMessage(from, { text: `⚡ *WEAPON EVOLVED*\n${item.name} has evolved! Stats increased by 50%.`   , mentions: [sender] });
             }

             else if (command === 'collections') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 const cols = user.collections || { curses: [], weapons: [], armor: [], summons: [] };
                 let msg = `📚 *COLLECTIONS*\n───\n`;
                 msg += `👾 Curses: ${cols.curses?.length || 0}/26\n`;
                 msg += `🗡️ Weapons: ${cols.weapons?.length || 0}/8\n`;
                 msg += `🛡️ Armor: ${cols.armor?.length || 0}/11\n`;
                 msg += `🐾 Summons: ${cols.summons?.length || 0}/20\n`;
                 await sock.sendMessage(from, { text: msg   , mentions: [sender] });
             }

            else if (command === 'dungeon' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (combat) { await sock.sendMessage(from, { text: 'Already in combat.'   , mentions: [sender] }); }
                const dungeonId = parseInt(args[0]);
                const dungeon = DUNGEON_TEMPLATES.find(d => d.id === dungeonId);
                if (!dungeon) { await sock.sendMessage(from, { text: 'Invalid dungeon ID.'   , mentions: [sender] }); }
                if (user.level < dungeon.minLevel) { await sock.sendMessage(from, { text: `Need level ${dungeon.minLevel} to enter.`   , mentions: [sender] }); }
                if (user.stats.CE < dungeon.ce_cost) { await sock.sendMessage(from, { text: `Need ${dungeon.ce_cost} CE.`   , mentions: [sender] }); }
                user.stats.CE -= dungeon.ce_cost;
                const floor = 1;
                const enemyName = dungeon.enemies[0];
                const enemyGrade = clamp(4 - Math.floor(dungeon.id * 0.8), 0, 4);
                const scaled = scaleEnemy(enemyGrade, user.level);
                const enemy = {
                    name: enemyName,
                    grade: scaled.grade,
                    stats: scaled.stats,
                    technique: CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)],
                    skills: INNATE_TECHNIQUES[CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)]]?.moves || {}
                };
                user.dungeon_state = { dungeon_id: dungeon.id, floor, max_floors: dungeon.floors, enemies: dungeon.enemies, boss: dungeon.boss, rewards: dungeon.rewards };
                db.combats[sender] = { player: user, enemy, round: 1, dungeon: true, dungeon_id: dungeon.id, floor, weaponOnly: true, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false };
                saveDb();
                await sock.sendMessage(from, { text: `🕳️ **DUNGEON ENTERED:** ${dungeon.name}\n───\nFloor: ${floor}/${dungeon.floors}\n${dungeon.desc}\n───\n👁️ It's preparing: ${enemyIntentHint(db.combats[sender].enemyIntent)}\n*Directives:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .guard | .flee | .dungeon-next`   , mentions: [sender] });
            }

            else if (command === 'dungeon-next') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.dungeon_state) { await sock.sendMessage(from, { text: 'Not in a dungeon.'   , mentions: [sender] }); }
                const ds = user.dungeon_state;
                const dungeon = DUNGEON_TEMPLATES.find(d => d.id === ds.dungeon_id);
                if (!dungeon) { await sock.sendMessage(from, { text: 'Dungeon not found.'   , mentions: [sender] }); }
                if (ds.floor >= dungeon.floors) {
                    const rewardXp = dungeon.rewards.xp + roll(50, 100);
                    const rewardGold = dungeon.rewards.gold + roll(30, 60);
                     const rarity = rollRarity(dungeon.rewards.minRarity);
                     const equipNames = Object.keys(EQUIPMENT_DB);
                     const rewardEquip = generateEquipment(pick(equipNames), dungeon.rewards.minRarity);
                     const xpBoost = getArmorEffect(user, 'xp_boost') || 0;
                     user.xp += Math.floor(rewardXp * (1 + xpBoost));
                     user.skill_points = (user.skill_points || 0) + 1;
                    checkLevelUp(user);
                    user.wallet += rewardGold;
                    if (rewardEquip) user.inventory.push(rewardEquip);
                    user.dungeon_state = null;
                    saveDb();
                    await sock.sendMessage(from, { text: `🏆 **DUNGEON COMPLETE!**\n───\n**${dungeon.name}** cleared!\nRewards: +${rewardXp} XP, +${rewardGold} Gold\nLoot: ${rewardEquip ? `${rewardEquip.rarityColor} ${rewardEquip.name}` : 'Nothing'}\n───\n*Return to hub or enter another dungeon.*`   , mentions: [sender] }); continue;
                }
                ds.floor++;
                const enemyName = dungeon.enemies[ds.floor - 1] || dungeon.enemies[dungeon.enemies.length - 1];
                const enemyGrade = clamp(4 - Math.floor(dungeon.id * 0.8) - ds.floor, 0, 4);
                const scaled = scaleEnemy(enemyGrade, user.level);
                 const isBoss = ds.floor === dungeon.floors;
                 const bossPhases = isBoss ? (dungeon.bossPhases || []) : [];
                 const enemy = {
                     name: isBoss ? dungeon.boss : enemyName,
                     grade: scaled.grade,
                     stats: { ...scaled.stats, HP: scaled.stats.HP * (isBoss ? 3 : 1), Max_HP: scaled.stats.Max_HP * (isBoss ? 3 : 1) },
                     technique: CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)],
                     skills: INNATE_TECHNIQUES[CURSE_NAMES[Math.floor(Math.random() * CURSE_NAMES.length)]]?.moves || {},
                     bossPhases,
                     currentPhaseIndex: 0
                 };
                 db.combats[sender] = { player: user, enemy, round: 1, dungeon: true, dungeon_id: dungeon.id, floor: ds.floor, weaponOnly: true, playerStatus: [], enemyIntent: pickEnemyMove(), enemyGuarding: false, guarding: false, bossPhaseTriggered: {} };
                 saveDb();
                 await sock.sendMessage(from, { text: `🕳️ **DUNGEON FLOOR ${ds.floor}/${dungeon.floors}**\n───\nEnemy: ${isBoss ? '👑 **BOSS:** ' : ''}${enemy.name}\n───\n👁️ It's preparing: ${enemyIntentHint(db.combats[sender].enemyIntent)}\n*Directives:* .attack | .technique-1 | .technique-2 | .technique-3 | .technique-4 | .guard | .flee | .dungeon-next`   , mentions: [sender] });
            }

            else if (command === 'dungeon-leave') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.dungeon_state) { await sock.sendMessage(from, { text: 'Not in a dungeon.'   , mentions: [sender] }); }
                user.dungeon_state = null;
                if (db.combats[sender]) delete db.combats[sender];
                saveDb();
                await sock.sendMessage(from, { text: '🚪 Left the dungeon. Returning to hub.'   , mentions: [sender] });
            }

            else if (command === 'achievements') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const unlocked = user.achievements || [];
                let msg = '🏆 **ACHIEVEMENTS** 🏆\n───\n';
                Object.entries(ACHIEVEMENT_DEFS).forEach(([key, ach]) => {
                    const done = unlocked.includes(key);
                    msg += `${done ? '✅' : '🔒'} **${ach.name}**: ${ach.desc}\n`;
                });
                msg += `───\nProgress: ${unlocked.length}/${Object.keys(ACHIEVEMENT_DEFS).length}`;
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

            else if (command === 'titles') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                let msg = '🎖️ **TITLE PERKS** 🎖️\n───\n';
                Object.entries(TITLE_PERKS).forEach(([title, perks]) => {
                    if (title === 'None') return;
                    const active = user.title === title;
                    msg += `${active ? '✅' : '🔒'} **${title}**\n`;
                    if (Object.keys(perks).length > 0) {
                        Object.entries(perks).forEach(([k, v]) => {
                            msg += `   > ${k}: ${v > 0 ? '+' : ''}${v}\n`;
                        });
                    } else {
                        msg += '   > No perks\n';
                    }
                    msg += '\n';
                });
                msg += '───\n*Some titles are earned through special actions.*';
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

            else if (command === 'stats') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const base = calcPower(user);
                const combat = getCombatStats(user);
                const perks = getTitlePerks(user.title);
                let msg = `📊 **DETAILED STATS** 📊\n───\n`;
                msg += `**Base Stats:**\n> Attack: ${base.attack}\n> Defense: ${base.defense}\n> Speed: ${base.speed}\n\n`;
                msg += `**Combat Stats:**\n> Attack: ${combat.attack}\n> Defense: ${combat.defense}\n> Speed: ${combat.speed}\n> Crit Chance: ${((user._combat_crit_chance || 0.05) * 100).toFixed(1)}%\n\n`;
                msg += `**Title Perks (${user.title}):**\n`;
                if (Object.keys(perks).length > 0) {
                    Object.entries(perks).forEach(([k, v]) => msg += `> ${k}: ${v > 0 ? '+' : ''}${v}\n`);
                } else {
                    msg += '> None\n';
                }
                msg += `\n**Unlocked Skills:** ${(user.unlocked_skills || []).length}\n`;
                msg += `───\n*Use .skills to view your cross-universe abilities.*`;
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

            else if (command === 'guild') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.guild_id) { await sock.sendMessage(from, { text: 'You are not in a guild. Use `.guild-create <name>` to start one.'   , mentions: [sender] }); }
                const guild = db.guilds?.[user.guild_id];
                if (!guild) { await sock.sendMessage(from, { text: 'Guild not found.'   , mentions: [sender] }); }
                const members = guild.members || [];
                let msg = `🏰 **GUILD:** ${guild.name}\n───\nLeader: ${guild.leader}\nMembers: ${members.length}\nLevel: ${guild.level || 1}\n───\n`;
                members.forEach(m => {
                    msg += `> ${m}\n`;
                });
                await sock.sendMessage(from, { text: msg   , mentions: [sender] });
            }

            else if (command === 'guild-create' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (user.guild_id) { await sock.sendMessage(from, { text: 'You are already in a guild. Leave first.'   , mentions: [sender] }); continue; }
                const name = args.join(' ');
                if (user.wallet < 1000) { await sock.sendMessage(from, { text: 'Need 1000 gold to create a guild.'   , mentions: [sender] }); continue; }
user.wallet -= 1000;
                const guildId = 'guild_' + Date.now();
                db.guilds = db.guilds || {};
                db.guilds[guildId] = {
                    id: guildId,
                    name,
                    leader: sender,
                    members: [sender],
                    level: 1,
                    xp: 0,
                    vault: 0
                };
                user.guild_id = guildId;
                saveDb();
                await sock.sendMessage(from, { text: `🏰 Guild **${name}** created! You are the leader.`   , mentions: [sender] });
            }

            else if (command === 'guild-invite' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.guild_id) { await sock.sendMessage(from, { text: 'You are not in a guild.'   , mentions: [sender] }); }
                const guild = db.guilds?.[user.guild_id];
                if (!guild || guild.leader !== sender) { await sock.sendMessage(from, { text: 'Only guild leaders can invite.'   , mentions: [sender] }); }
                const target = args[0];
                if (!db.users[target]) { await sock.sendMessage(from, { text: 'User not found.'   , mentions: [sender] }); }
                if (db.users[target].guild_id) { await sock.sendMessage(from, { text: 'User is already in a guild.'   , mentions: [sender] }); }
                guild.members.push(target);
                db.users[target].guild_id = user.guild_id;
                saveDb();
                await sock.sendMessage(from, { text: `✅ Invited ${target} to the guild.`   , mentions: [sender] });
            }

            else if (command === 'guild-leave') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                if (!user.guild_id) { await sock.sendMessage(from, { text: 'You are not in a guild.'   , mentions: [sender] }); }
                const guild = db.guilds?.[user.guild_id];
                if (!guild) { await sock.sendMessage(from, { text: 'Guild not found.'   , mentions: [sender] }); }
                if (guild.leader === sender) { await sock.sendMessage(from, { text: 'Leaders must transfer leadership or disband the guild.'   , mentions: [sender] }); }
                guild.members = guild.members.filter(m => m !== sender);
                user.guild_id = null;
                saveDb();
                await sock.sendMessage(from, { text: '👋 You left the guild.'   , mentions: [sender] });
            }

            else if (command === 'clan-create' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                processClanMaintenance();
                if (user.clan) { await sock.sendMessage(from, { text: 'You are already in a clan. Leave it first with `.leave-clan <name>`.'   , mentions: [sender] }); continue; }
                const name = args.join(' ').trim();
                if (!name) { await sock.sendMessage(from, { text: 'Usage: .clan-create <clan-name>'   , mentions: [sender] }); continue; }
                if (findClanByName(name)) { await sock.sendMessage(from, { text: 'A clan with that name already exists.'   , mentions: [sender] }); continue; }
                if ((user.wallet || 0) < CLAN_CREATE_COST) { await sock.sendMessage(from, { text: `You need ${fmtNum(CLAN_CREATE_COST)} (${CLAN_CREATE_COST.toLocaleString()}) K-Coins to found a clan.`   , mentions: [sender] }); continue; }
                user.wallet -= CLAN_CREATE_COST;
                const now = Date.now();
                db.clans = db.clans || {};
                 db.clans[normClanName(name)] = {
                     name,
                     head: sender,
                     head_name: user.name,
                     members: [sender],
                     created_at: now,
                     next_maintenance: now + CLAN_MAINTENANCE_INTERVAL,
                     debt: 0,
                     level: 1,
                     xp: 0,
                     bank: 0,
                     buffs: [],
                     missions: [],
                     wars: {},
                     boss: null
                 };
                user.clan = name;
                awardTitle(user, 'HOKAGE');
                saveDb();
                await sock.sendMessage(from, { text: `🏯 Clan *${name}* has been founded!\nYou are now the *HOKAGE* of ${name}.\n💸 Cost: ${CLAN_CREATE_COST.toLocaleString()} K-Coins\n🛠️ Upkeep: ${CLAN_MAINTENANCE_COST.toLocaleString()} K-Coins every 30 days (auto-deducted from your wallet).\n👥 Max members: ${CLAN_MAX_MEMBERS}`   , mentions: [sender] });
            }

            else if (command === 'clan-join' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                processClanMaintenance();
                if (user.clan) { await sock.sendMessage(from, { text: 'You are already in a clan. Leave it first with `.leave-clan <name>`.'   , mentions: [sender] }); continue; }
                const name = args.join(' ').trim();
                const clan = findClanByName(name);
                if (!clan) { await sock.sendMessage(from, { text: 'No clan found with that name.'   , mentions: [sender] }); continue; }
                if (clan.members.length >= CLAN_MAX_MEMBERS) { await sock.sendMessage(from, { text: `Clan *${clan.name}* is full (${CLAN_MAX_MEMBERS}/${CLAN_MAX_MEMBERS} members).`   , mentions: [sender] }); continue; }
                if (clan.members.includes(sender)) { await sock.sendMessage(from, { text: 'You are already a member of this clan.'   , mentions: [sender] }); continue; }
                clan.members.push(sender);
                user.clan = clan.name;
                awardTitle(user, clanMemberTitle(clan.head_name));
                saveDb();
                await sock.sendMessage(from, { text: `✅ You joined clan *${clan.name}*!\n🎖️ Title granted: *${clanMemberTitle(clan.head_name)}*\n👥 Members: ${clan.members.length}/${CLAN_MAX_MEMBERS}`   , mentions: [sender] });
            }

            else if (command === 'leave-clan') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                processClanMaintenance();
                if (!user.clan) { await sock.sendMessage(from, { text: 'You are not in a clan.'   , mentions: [sender] }); continue; }
                const clan = findClanByName(args.length ? args.join(' ') : user.clan) || findClanByName(user.clan);
                if (!clan) { user.clan = null; saveDb(); await sock.sendMessage(from, { text: 'Clan not found; your clan status has been cleared.'   , mentions: [sender] }); continue; }
                if (clan.head === sender) {
                    // Head disbands the clan; all members lose their protection title.
                    for (const memberJid of clan.members) {
                        const mu = db.users[memberJid];
                        if (mu) { mu.clan = null; mu.title = 'None'; }
                    }
                    delete db.clans[normClanName(clan.name)];
                    saveDb();
                    await sock.sendMessage(from, { text: `🏯 As the HOKAGE, you disbanded clan *${clan.name}*. All members have been released.`   , mentions: [sender] });
                } else {
                    clan.members = clan.members.filter(mm => mm !== sender);
                    user.clan = null;
                    user.title = 'None';
                    saveDb();
                    await sock.sendMessage(from, { text: `👋 You left clan *${clan.name}*.`   , mentions: [sender] });
                }
            }

             else if (command === 'clan') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 processClanMaintenance();
                 const clan = user.clan ? findClanByName(user.clan) : (args.length ? findClanByName(args.join(' ')) : null);
                 if (!clan) { await sock.sendMessage(from, { text: 'You are not in a clan. Use `.clan-create <name>` to found one, or `.clan <name>` to view another clan.'   , mentions: [sender] }); continue; }
                 const nextDays = Math.max(0, Math.ceil((clan.next_maintenance - Date.now()) / (24 * 60 * 60 * 1000)));
                 const xpNeeded = clan.level * 10000;
                 let msg = `🏯 *CLAN:* ${clan.name}\n───\n👑 HOKAGE: ${clan.head_name}\n📊 Level: ${clan.level} | XP: ${fmtNum(clan.xp || 0)}/${fmtNum(xpNeeded)}\n👥 Members: ${clan.members.length}/${CLAN_MAX_MEMBERS}\n🏦 Bank: ${fmtNum(clan.bank || 0)} K-Coins\n💸 Debt: ${fmtNum(clan.debt || 0)} K-Coins\n🛠️ Next upkeep: ~${nextDays} day(s)\n`;
                 if (clan.buffs?.length) msg += `\n🧪 Active Buffs: ${clan.buffs.join(', ')}\n`;
                 if (clan.boss) msg += `\n👹 Clan Boss: *${clan.boss.name}* (HP: ${clan.boss.hp}/${clan.boss.maxHp})\n`;
                 clan.members.forEach(mm => {
                     const mu = db.users[mm];
                     msg += `> ${mu?.name || mm}${mm === clan.head ? ' 👑' : ''}\n`;
                 });
                 await sock.sendMessage(from, { text: msg   , mentions: [sender] });
             }

             else if (command === 'clan-donate' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 if (!user.clan) { await sock.sendMessage(from, { text: 'You are not in a clan.'   , mentions: [sender] }); continue; }
                 const clan = findClanByName(user.clan);
                 if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.'   , mentions: [sender] }); continue; }
                 const amount = parseInt(args[0]);
                 if (isNaN(amount) || amount <= 0) { await sock.sendMessage(from, { text: 'Usage: .clan-donate <amount>'   , mentions: [sender] }); continue; }
                 if ((user.wallet || 0) < amount) { await sock.sendMessage(from, { text: `You need ${fmtNum(amount)} K-Coins.`   , mentions: [sender] }); continue; }
                 user.wallet -= amount;
                 clan.bank = (clan.bank || 0) + amount;
                 clan.xp = (clan.xp || 0) + Math.floor(amount / 1000);
                 recordClanContribution(user, amount);
                 saveDb();
                 await sock.sendMessage(from, { text: `🏦 *DONATED* ${fmtNum(amount)} K-Coins to *${clan.name}*.\n🏯 Clan XP: +${Math.floor(amount / 1000)}`   , mentions: [sender] });
             }

             else if (command === 'clan-buff' && args[0]) {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 if (!user.clan) { await sock.sendMessage(from, { text: 'You are not in a clan.'   , mentions: [sender] }); continue; }
                 const clan = findClanByName(user.clan);
                 if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.'   , mentions: [sender] }); continue; }
                 if (clan.head !== sender) { await sock.sendMessage(from, { text: 'Only the HOKAGE can activate clan buffs.'   , mentions: [sender] }); continue; }
                 const buffName = args.join(' ').toLowerCase();
                 const buffCost = 50000;
                 if ((clan.bank || 0) < buffCost) { await sock.sendMessage(from, { text: `Clan bank needs ${fmtNum(buffCost)} K-Coins for a buff.`   , mentions: [sender] }); continue; }
                 clan.bank -= buffCost;
                 clan.buffs = clan.buffs || [];
                 clan.buffs.push(buffName);
                 saveDb();
                 await sock.sendMessage(from, { text: `🧪 *CLAN BUFF ACTIVATED:* ${buffName}\nCost: ${fmtNum(buffCost)} K-Coins`   , mentions: [sender] });
             }

             else if (command === 'clan-boss') {
                 if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                 if (!user.clan) { await sock.sendMessage(from, { text: 'You are not in a clan.'   , mentions: [sender] }); continue; }
                 const clan = findClanByName(user.clan);
                 if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.'   , mentions: [sender] }); continue; }
                 if (clan.head !== sender) { await sock.sendMessage(from, { text: 'Only the HOKAGE can summon the clan boss.'   , mentions: [sender] }); continue; }
                 if (!clan.boss) {
                     const bossGrade = Math.min(0, clan.level - 2);
                     clan.boss = {
                         name: `Clan Guardian Lv${clan.level}`,
                         grade: bossGrade,
                         hp: 5000 * clan.level,
                         maxHp: 5000 * clan.level,
                         atk: 200 * clan.level
                     };
                     saveDb();
                 }
                 await sock.sendMessage(from, { text: `👹 *CLAN BOSS SUMMONED:* ${clan.boss.name}\nHP: ${clan.boss.hp}/${clan.boss.maxHp}\nAll clan members can now attack with .attack`   , mentions: [sender] });
             }

            else if (command === 'l-clan') {
                processClanMaintenance();
                const clans = Object.values(db.clans || {});
                if (!clans.length) { await sock.sendMessage(from, { text: '🏯 No clans exist yet. Use `.clan-create <name>` to found one.', mentions: [sender] }); continue; }
                let msg = `🏯 *ALL CLANS IN THE REALM* — ${clans.length}\n──────────────────────────\n`;
                clans.slice().sort((a, b) => b.members.length - a.members.length).forEach((c, i) => {
                    msg += `${i + 1}. ${c.name}\n   👑 Head: ${c.head_name}\n   👥 Members: ${c.members.length}/${CLAN_MAX_MEMBERS}\n`;
                });
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

            else if (command === 'poorest-clan') {
                processClanMaintenance();
                const poorest = getPoorestClan();
                if (!poorest) { await sock.sendMessage(from, { text: 'There are no clans yet.'   , mentions: [sender] }); continue; }
                const head = db.users[poorest.head];
                const bal = head ? (head.wallet || 0) : 0;
                await sock.sendMessage(from, { text: `🥀 *POOREST CLAN:* ${poorest.name}\n👑 HOKAGE: ${poorest.head_name}\n🪙 Head wallet: ${bal.toLocaleString()} K-Coins\n💸 Debt: ${fmtNum(poorest.debt || 0)} K-Coins`   , mentions: [sender] });
            }

            else if (command === 'map') {
                try {
                    const canvas = drawWorldMap();
                    const buf = canvas.toBuffer('image/png');
                    await sock.sendMessage(from, { image: buf, caption: '🗺️ *KENNYJAKS WORLD MAP*\nNations: Spriggan (green) | Ishgar (blue)\nUse .dmap for the Dark Continent', mentions: [sender] });
                } catch (e) {
                    await sock.sendMessage(from, { text: '🗺️ *MAP OF THE REALM*\nNations: Spriggan | Ishgar\nUse .dmap for the Dark Continent\n───\nWorld generation failed, showing text mode.', mentions: [sender] });
                }
            }

            else if (command === 'villages') {
                const villages = Object.values(db.villages || {});
                const colonised = villages.filter(v => v.colonisedBy);
                let msg = `🏚️ *VILLAGES OF THE REALM* — ${villages.length} total\n`;
                if (colonised.length === 0) msg += 'No village is colonised yet. Use `.colonise <name>` as a clan HOKAGE.';
                else {
                    msg += `─── Colonised (${colonised.length}) ───\n`;
                    for (const v of colonised) {
                        msg += `> ${v.name} — ${v.coloniserClanName} (tax ${fmtNum(v.tax)}/day${v.rebellion ? ' ⚠️ REBELLION' : ''})\n`;
                    }
                }
                await sock.sendMessage(from, { text: msg, mentions: [sender] });
            }

            else if (command === 'colonise' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if (!user.clan) { await sock.sendMessage(from, { text: '🏯 You must be in a clan to colonise a village. Use `.clan-create <name>`.', mentions: [sender] }); continue; }
                const clan = findClanByName(user.clan);
                if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.', mentions: [sender] }); continue; }
                if (clan.head !== sender) { await sock.sendMessage(from, { text: '🏯 Only the clan HOKAGE can colonise a village.', mentions: [sender] }); continue; }
                if (findClanVillage(clan)) { await sock.sendMessage(from, { text: '🏯 Your clan already colonises a village. Use `.de-col` first.', mentions: [sender] }); continue; }
                const village = findVillageByName(args.join(' '));
                if (!village) { await sock.sendMessage(from, { text: '🏚️ No village with that name. Use `.villages` to list them.', mentions: [sender] }); continue; }
                if (village.colonisedBy) { await sock.sendMessage(from, { text: `🏚️ ${village.name} is already colonised by another clan.`, mentions: [sender] }); continue; }
                village.colonisedBy = normClanName(clan.name);
                village.coloniserClanName = clan.name;
                village.tax = 0; village.dailyTax = 0; village.lastTaxDay = Date.now(); village.rebellion = false; village.mission = null;
                saveDb();
                await sock.sendMessage(from, { text: `🏯 *VILLAGE COLONISED:* ${village.name}!\nYour clan now rules here. Set a daily tax with \`.set-taxes <amt>\` (taxes flow into your wallet). Beware: taxes above 13,000,000/day spark a rebellion!`, mentions: [sender] });
            }

            else if (command === 'set-taxes' && args[0]) {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if (!user.clan) { await sock.sendMessage(from, { text: '🏯 You must be in a clan.', mentions: [sender] }); continue; }
                const clan = findClanByName(user.clan);
                if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.', mentions: [sender] }); continue; }
                if (clan.head !== sender) { await sock.sendMessage(from, { text: '🏯 Only the clan HOKAGE can set taxes.', mentions: [sender] }); continue; }
                const village = findClanVillage(clan);
                if (!village) { await sock.sendMessage(from, { text: '🏯 Your clan does not colonise any village. Use `.colonise <name>`.', mentions: [sender] }); continue; }
                const amt = parseInt(args[0]);
                if (isNaN(amt) || amt < 0) { await sock.sendMessage(from, { text: 'Invalid tax amount.', mentions: [sender] }); continue; }
                village.tax = amt;
                saveDb();
                await sock.sendMessage(from, { text: `🏯 Daily tax for *${village.name}* set to ${amt.toLocaleString()} K-Coins. Collected into your wallet each day.${amt > 13000000 ? '\n⚠️ This exceeds 13,000,000/day — the villagers will rebel!' : ''}`, mentions: [sender] });
            }

            else if (command === 'de-col') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.', mentions: [sender] }); continue; }
                if (!user.clan) { await sock.sendMessage(from, { text: '🏯 You must be in a clan.', mentions: [sender] }); continue; }
                const clan = findClanByName(user.clan);
                if (!clan) { await sock.sendMessage(from, { text: 'Clan not found.', mentions: [sender] }); continue; }
                if (clan.head !== sender) { await sock.sendMessage(from, { text: '🏯 Only the clan HOKAGE can release a village.', mentions: [sender] }); continue; }
                const village = findClanVillage(clan);
                if (!village) { await sock.sendMessage(from, { text: '🏯 Your clan does not colonise any village.', mentions: [sender] }); continue; }
                village.colonisedBy = null; village.coloniserClanName = null; village.tax = 0; village.rebellion = false; village.mission = null; village.dailyTax = 0;
                saveDb();
                await sock.sendMessage(from, { text: `🏚️ Your clan has relinquished *${village.name}*.`, mentions: [sender] });
            }

            else if (command === 'tag-team') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const combat = db.combats[sender];
                if (!combat) { await sock.sendMessage(from, { text: 'You are not in combat.'   , mentions: [sender] }); continue; }
                if (!combat.missionFight) { await sock.sendMessage(from, { text: 'Tag team is only available during village missions.'   , mentions: [sender] }); continue; }
                if (combat.tagTeamActive) { await sock.sendMessage(from, { text: 'You already have a tag team partner active.'   , mentions: [sender] }); continue; }
                if (!combat.tagTeamNpc) { await sock.sendMessage(from, { text: 'No sorcerer NPC is available to tag team with.'   , mentions: [sender] }); continue; }
                const npc = combat.tagTeamNpc;
                tagTeamNpc(user, npc.id);
                combat.tagTeamActive = true;
                combat.participants.push(sender + '_npc_' + npc.id);
                const npcStats = buildNpcEnemy({ id: npc.id, name: npc.name, special: npc.id === 'yuta' || npc.id === 'todo', grade: npc.grade }, user);
                combat.npcAlly = { ...npcStats, name: npc.name, hp: npcStats.stats.Max_HP, maxHp: npcStats.stats.Max_HP, atk: npcStats.atk };
                saveDb();
                await sock.sendMessage(from, { text: `🤝 *TAG TEAM FORMED!*\nYou and ${npc.name} are now fighting together against ${combat.enemy.name}!\nYour combined strength will strike the enemy each round.\nAchievement "Besto Friendo" will be awarded upon victory.`, mentions: [sender] });
            }

            else if (command === 'bf') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const combat = db.combats[sender];
                if (!combat) { await sock.sendMessage(from, { text: 'You are not in combat.'   , mentions: [sender] }); continue; }
                if (user.stats.HP >= 20) { await sock.sendMessage(from, { text: '*BF can only be used when HP is below 20.*', mentions: [sender] }); continue; }
                const npcId = user._lastTagTeamNpc;
                if (!npcId) { await sock.sendMessage(from, { text: '*You have no tag team ally to call.* Complete a village mission with a sorcerer NPC first.*', mentions: [sender] }); continue; }
                const npcs = db.sorcererNpcs?.active || {};
                const npc = npcs[npcId];
                if (!npc) { await sock.sendMessage(from, { text: '*Your tag team ally is no longer available.*', mentions: [sender] }); continue; }
                const npcStats = buildNpcEnemy({ id: npc.id, name: npc.name, special: npc.id === 'yuta' || npc.id === 'todo', grade: npc.grade }, user);
                const npcDmg = Math.max(1, npcStats.atk + Math.floor(Math.random() * 12));
                if (combat.enemy.stats.HP > 0) {
                    combat.enemy.stats.HP -= npcDmg;
                    await sock.sendMessage(from, { text: `👊 *${npc.name} (BEST FRIENDO) ASSISTS!*\nDealt *${npcDmg}* damage to ${combat.enemy.name}!\n❤️ Your HP: ${user.stats.HP}/${user.stats.Max_HP}`, mentions: [sender] });
                }
            }

            else if (command === 'tag-team') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }
                const combat = db.combats[sender];
                if (!combat) { await sock.sendMessage(from, { text: 'You are not in combat.'   , mentions: [sender] }); continue; }
                if (!combat.missionFight) { await sock.sendMessage(from, { text: 'Tag team is only available during village missions.'   , mentions: [sender] }); continue; }
                if (combat.tagTeamActive) { await sock.sendMessage(from, { text: 'You already have a tag team partner active.'   , mentions: [sender] }); continue; }
                if (!combat.tagTeamNpc) { await sock.sendMessage(from, { text: 'No sorcerer NPC is available to tag team with.'   , mentions: [sender] }); continue; }
                const npc = combat.tagTeamNpc;
                tagTeamNpc(user, npc.id);
                combat.tagTeamActive = true;
                user._lastTagTeamNpc = npc.id;
                combat.participants.push(sender + '_npc_' + npc.id);
                const npcStats = buildNpcEnemy({ id: npc.id, name: npc.name, special: npc.id === 'yuta' || npc.id === 'todo', grade: npc.grade }, user);
                combat.npcAlly = { ...npcStats, name: npc.name, hp: npcStats.stats.Max_HP, maxHp: npcStats.stats.Max_HP, atk: npcStats.atk };
                saveDb();
                await sock.sendMessage(from, { text: `🤝 *TAG TEAM FORMED!*\nYou and ${npc.name} are now fighting together against ${combat.enemy.name}!\nYour combined strength will strike the enemy each round.\nAchievement "Besto Friendo" will be awarded upon victory.`, mentions: [sender] });
            }

            else if (command === 'v-a') {
                if (!user || !user.registered) { await sock.sendMessage(from, { text: 'Not registered.'   , mentions: [sender] }); continue; }                if (!from.endsWith('@g.us')) return;
                if (!isOwner(sender) && !isMod(sender)) {
                    await sock.sendMessage(from, { text: '⛔ Only the owner or a mod can make the bot leave.'   , mentions: [sender] }); continue;
                }
                await sock.leaveGroup(from);
            }
            else {
                await sock.sendMessage(from, { text: 'FUCK, THATS NOT A COMMAND'   , mentions: [sender] });
            }
           } catch (err) {
             logger.error({ err, command, sender, from }, '[message handler error]');
           }
        }
    });
}

// ── Multi-device launcher ──
// Usage:
//   node index.js                          run device "main" (QR if not paired)
//   node index.js <phone>                  pair + run device "main" via pairing code
//   node index.js pair <phone> [deviceId]  pair + run a named device via pairing code
//   node index.js dev1,dev2                run multiple already-paired devices
function launch() {
    const argv = process.argv.slice(2);
    const isPhone = (s) => /^\+?\d{6,}$/.test(s.replace(/[^0-9]/g, ''));
    if (argv[0] === 'pair') {
        const phone = argv[1];
        const id = argv[2] || 'main';
        if (!phone) { logger.error('Usage: node index.js pair <phoneNumber> [deviceId]'); return; }
        console.log(`Pairing device '${id}' with phone ${phone}`);
        startBot(id, phone);
    } else if (argv.length && isPhone(argv[0])) {
        startBot('main', argv[0]);
    } else if (argv.length) {
        argv.join(',').split(',').map(s => s.trim()).filter(Boolean).forEach(id => startBot(id));
    } else {
        startBot('main');
    }
}

launch();
