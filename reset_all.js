#!/usr/bin/env node
// Full server reset: users, summons, fingers, world state.
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'jjkbot.json');
const backupPath = path.join(__dirname, 'database', `jjkbot.json.fullreset.${Date.now()}.bak`);

console.log('Backing up current database...');
fs.copyFileSync(dbPath, backupPath);

let db;
try {
    db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
} catch (e) {
    console.error('Failed to parse database:', e.message);
    process.exit(1);
}

// 1. Reset all users
const users = db.users || {};
let resetCount = 0;
for (const [jid, u] of Object.entries(users)) {
    if (!u || typeof u !== 'object') continue;
    
    // Keep only essential registration data, strip everything else
    const keptName = u.name || '';
    const keptJid = jid;
    
    // Full reset
    db.users[jid] = {
        player_id: keptJid,
        name: keptName,
        registered: false,
        alignment: null,
        innate_technique_id: null,
        technique_1: null,
        technique_2: null,
        technique_3: null,
        technique_4: null,
        technique_5: null,
        custom_technique: null,
        stats: { HP: 120, Max_HP: 120, CE: 100, Max_CE: 100, atk: 10, def: 5, spd: 10 },
        xp: 0,
        xp_needed: 31000,
        level: 1,
        grade: 4,
        wallet: 500,
        gold: 500,
        bank: 0,
        lastDaily: 0,
        last_heal: 0,
        last_fish: 0,
        inventory: [],
        ownedSummons: [],
        summon: { active: false, name: 'None', HP: 0, Max_HP: 0, CE: 0, Max_CE: 0, atk: 0, move: null, effect: null, pl: 0 },
        loots: [],
        skills: {},
        skill_points: 0,
        titles: [],
        active_status_effects: [],
        current_node: 'Tokyo Jujutsu High Hub',
        corruption: 0,
        heavenly_restriction: false,
        unlocked_features: { RCT: false, Domain: false, Simple_Domain: false },
        command_count: 0,
        consecutive_wins: 0,
        finger_count: 0,
        dungeon_state: null,
        active_curse_spawn: null,
        loser_until: 0,
        comedian_until: 0,
        comedian_burnout_until: 0,
        mastermind_revive_until: 0,
        midasApplied: false,
        sovereignApplied: false,
        combo_god_until: 0,
        taunt_streak: 0,
        lastTaunt: 0,
        pvp_wins: 0,
        pvp_losses: 0,
        cullingGame: { points: 0, colony: null, koganeMood: 'neutral', lastPointChange: Date.now(), techniqueLocked: false, techniqueLockUntil: null, penaltyActive: false, penaltyUntil: null },
        domain_unlocked: false,
        domain_name: null,
        weapon: null,
        armor: null,
        trained_stats: { attack: 0, defense: 0, max_hp: 0, max_ce: 0 },
        _bonus_attack: 0,
        _bonus_defense: 0,
        _temp_speed_buff: undefined,
        _dharma_stacks: 0,
        _skillCeBonus: 0,
        _combat_crit_chance: 0.05,
        _combat_tech_bonus: 0,
        _judgeman_executioner_ready: false,
        _rika_mode: false,
        _rika_until: 0,
        _cursed_army: [],
        _vow_until: 0,
        _comedian_until: 0,
        _comedian_burnout_until: 0,
        _mastermind_revive_until: 0,
        _midasApplied: false,
        _sovereignApplied: false,
        _daddyHits: {},
        _enemy_original_skills: null,
        _enemy_original_technique: null,
        _judgeman_rounds: 0,
        _judgeman_weak: false,
    };
    resetCount++;
}

// 2. Clear all combats
const combats = db.combats || {};
for (const [jid, c] of Object.entries(combats)) {
    delete db.combats[jid];
}

// 3. Clear PvP matches
const pvp = db.pvp || {};
for (const [jid, m] of Object.entries(pvp)) {
    delete db.pvp[jid];
}

// 4. Clear sold summons - return all to shop
const soldSummons = db.soldSummons || {};
for (const [sid, owner] of Object.entries(soldSummons)) {
    delete db.soldSummons[sid];
}
// Clear all user ownedSummons references
for (const [jid, u] of Object.entries(users)) {
    if (u && u.ownedSummons && u.ownedSummons.length) {
        db.users[jid].ownedSummons = [];
        db.users[jid].summon = { active: false, name: 'None', HP: 0, Max_HP: 0, CE: 0, Max_CE: 0, atk: 0, move: null, effect: null, pl: 0 };
    }
}

// 5. Reset Sukuna fingers - scatter all 20
db.scatteredFingers = 20;
db.sukunaFingers = null;
if (!db.sukunaFingers) {
    const CURSES = require('./database/curse.json').curses || [];
    db.sukunaFingers = { remaining: 20, curses: {} };
    CURSES.slice(0, 20).forEach((c, i) => {
        db.sukunaFingers.curses[i] = { name: c.name, taken: false, takenBy: null };
    });
}

// 6. Reset loot pool
db.lootPool = {
    limitless_six_eyes: true,
    courtroom_domain: true,
    idle_transfiguration: true,
    black_sparks: true,
    king_of_curses: true,
    blood_manipulation: true,
    comedian: true,
    cursed_spirit_manipulation: true,
    copy_mimicry: true,
    cursed_energy_discharge: true,
    daddyraga: true,
    entropys_loom: true,
    jackpot: true,
    midas_touch: true,
    sovereigns_core: true,
    boogie_woogie: true,
};

// 7. Reset world state
db.world = {
    villages: {},
    activeQuest: null,
    darkContinent: {
        active: false,
        regions: {},
        shards: [],
        pandoraBox: { locked: true, keyFound: false, kingsUnleashed: false, gojoEncountered: false }
    }
};

// 8. Clear shops
db.shops = {};

// 9. Clear active quest
db.activeQuest = null;

// 10. Clear skill data but keep structure
db.userSkills = {};

// 11. Clear guilds
db.guilds = {};

// 12. Clear clans
db.clans = {};

// 13. Clear culling game
db.cullingGame = { active: false, colony: null, players: {}, rules: [], startTime: null };

// Save
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(`Full reset complete. ${resetCount} users reset.`);
console.log(`Backup saved to: ${backupPath}`);
console.log('All summons returned to shop.');
console.log('All 20 Sukuna fingers scattered.');
console.log('Quest gold reduced to 500,000.');
