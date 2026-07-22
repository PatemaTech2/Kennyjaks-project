# KENNYJAKS BOT — SYSTEM ARCHITECTURE

**Version:** 1.0  
**Runtime:** Node.js + WhatsApp (`@whiskeysockets/baileys` v7)  
**Main File:** `index.js` (~8100 lines, monolithic architecture)  
**Database:** File-based JSON (`database/jjkbot.json`)  

---

## TABLE OF CONTENTS

1. [Overall Architecture](#overall-architecture)
2. [Database System](#database-system)
3. [User System](#user-system)
4. [Combat System (PvE)](#combat-system-pve)
5. [PvP System](#pvp-system)
6. [Culling Game System](#culling-game-system)
7. [Sukuna Raid System](#sukuna-raid-system)
8. [Heavenly Restriction System](#heavenly-restriction-system)
9. [Economy System](#economy-system)
10. [Clan & Village System](#clan--village-system)
11. [Summon System](#summon-system)
12. [Equipment System](#equipment-system)
13. [Anti-Ban System](#anti-ban-system)
14. [Mod Commands](#mod-commands)
15. [AI Systems](#ai-systems)
16. [Broadcast System](#broadcast-system)

---

## 1. OVERALL ARCHITECTURE

### Structure
The bot is a **single monolithic file** (`index.js`) using:
- **Baileys** for WhatsApp WebSocket connectivity
- **File-based JSON database** (no external DB server)
- **Event-driven** architecture via `sock.ev.on('messages.upsert', ...)`

### Main Components

| Component | Lines | Description |
|-----------|-------|-------------|
| `startBot()` | 4406–8073 | Main socket setup, anti-ban wrapper, event listeners, command router |
| `launch()` | 8081–8099 | CLI launcher for multi-device support |
| Data constants | 1–858 | `INNATE_TECHNIQUES`, `CROSS_UNIVERSE_SKILLS`, `TOKYO_MAP`, `ITEMS`, `ARMOR_SHOP`, `WEAPON_SHOP`, `SUMMON_SHOP`, `DUNGEON_TEMPLATES` |
| State objects | 41–118 | `db`, `mods`, `config`, backup system |

### Event Flow
1. **Boot** → `launch()` → `startBot(deviceId)` → Baileys socket connects
2. **Connection** → `connection.update` handler saves device JID, auto-adds bot as mod
3. **Message** → `messages.upsert` handler:
   - Security gate (ban check, spam check, cooldown)
   - Unregistered guard
   - Prison Realm seal check
   - Culling Game restrictions
   - Quest answer handler (`.q-`)
   - Combat routing (PvE → PvP → NPC → idle)
   - Command dispatcher (`if/else if` chain)

---

## 2. DATABASE SYSTEM

### File Structure
```
/home/benimaru/kehnn/database/
├── jjkbot.json       — Main user/world DB (primary)
├── config.json       — Owner, banned list, anti-ban config
├── mod.json          — Mod JID list
├── curse.json        — Curse definitions
└── avatars/          — Profile pictures
```

### Key Database Object: `db`
```javascript
db = {
  enabledGroups: {},       // Group IDs where bot is active
  users: {},               // Key: JID → User object
  combats: {},             // Key: JID → Combat object (PvE)
  world: {},               // TimeOfDay, district danger, events
  shops: {},               // Player-owned shops
  soldSummons: {},         // Sold summon IDs (one-of-a-kind)
  activeQuest: null,       // Current global trivia quest
  scatteredFingers: 0,     // Remaining Sukuna fingers
  pvp: {},                 // Key: group JID → PvP match
  villages: {},            // 500 villages (id → village object)
  darkContinent: {         // Dark Continent exploration
    active: false,
    regions: {},           // 100 regions
    shards: [],            // Pandora shard locations
    pandoraBox: { locked, keyFound, kingsUnleashed, gojoEncountered }
  },
  userSkills: {},          // Key: JID → array of skill IDs (max 10)
  cullingGame: {},         // Active Culling Game state
  clans: {},               // Key: lowercase name → clan object
  sukuna: null,            // Active Sukuna raid state
  sukunaFingers: { remaining, curses: {} }
};
```

### Persistence Functions
| Function | Description |
|----------|-------------|
| `saveDb()` | Async write `jjkbot.json` (fire-and-forget) |
| `saveConfig()` | Write `config.json` |
| `saveMods()` | Write `mod.json` |
| `createBackup()` | Hourly backup of all DB files, keeps last 24 |

### User Object Structure
```javascript
{
  player_id: "jid@s.whatsapp.net",
  name: "Display Name",
  alignment: "Sorcerer" | "Curse User",
  grade: 0-4,              // 0 = Special Grade
  level: 1-1000,
  xp: 0,
  xp_needed: 30000 + 1000 * level^2,
  title: "None",
  stats: {
    HP: 120, Max_HP: 120,
    CE: 100, Max_CE: 100,
    Output: 1, Refinement: 10
  },
  skill_points: 0,
  trained_stats: { attack: 0, defense: 0, max_hp: 0, max_ce: 0 },
  equipment: { weapon: "None", armor: "None", accessory: "None", relic: "None" },
  summon: { active, name, HP, Max_HP, CE, Max_CE, atk, move, effect, pl },
  innate_technique_id: "Limitless",
  skills: { technique_moves },
  unlocked_features: { RCT: false, Domain: false, Simple_Domain: false },
  active_status_effects: [],
  gold: 500,
  wallet: 0,
  bank: 0,
  current_node: "Tokyo Jujutsu High Hub",
  loots: [],               // Unique loot IDs
  quirks: [],              // HR quirks (max 2)
  prisonRealm: null,       // { sealedBy, sealedAt, releasedAt }
  cullingGame: { points, colony, lastPointChange, ... },
  clan: null,
  guild_id: null,
  corruption: 0,
  weapons_owned: [],       // Multi-weapon for HR users
  weapon: {},              // Currently equipped weapon
  heavenly_restriction: false,
  fingers: [],             // Sukuna fingers held
  // ... 50+ fields total
}
```

---

## 3. USER SYSTEM

### Registration Flow
1. `.start` → Initialize player
2. `.reg-curse` / `.reg-fighter` → Choose alignment
3. `.register <name>` → Set display name

### `initPlayer(jid, alignment, technique)`
Creates a new user with:
- Level 1, Grade 4, 120 HP, 100 CE, 500 gold
- Random innate technique based on alignment
- Default equipment (all "None")
- Default summon (inactive)
- `unlocked_features: { RCT: false, Domain: false, Simple_Domain: false }`

### Stats & Power Model
- **Grade bands**: Grade 4 (lvl 1-9), Grade 3 (10-29), Grade 2 (30-69), Grade 1 (70-699), Special Grade (700+)
- `calcPower(user)`: Base stats + trained stats + title perks + loot modifiers
- `getCombatStats(user)`: Adds weapon/armor/accessory/relic stats, armor effects, loot multipliers

### Level & Grade Progression
- XP needed: `30000 + 1000 * level^2`
- `calculateGrade(level)`: Exponential grade thresholds
- Max level: 1000
- Level up grants +1 skill point, recalculates stats

### Effective Grade Scaling
- `getEffectiveGrade(user)`: `clamp(grade - floor(level/10), 0, 4)`
- Enemies scale to player's effective grade

---

## 4. COMBAT SYSTEM (PvE)

### Combat Initialization
- `.spawn-curse`: Spawns a random curse from `CURSES` array
- `.b-curse`: Creates `db.combats[sender]` with scaled enemy stats
- `.dungeon <id>`: Creates dungeon combat with floor progression

### Combat Flow (`handleNpcFight`, line 1382)
1. **Status tick**: `tickCombatStatus()` applies DoT damage
2. **Player action**: `.attack`, `.technique-1..4`, `.ut-1..4`, `.domain`, `.su`, `.rct`, `.guard`, `.flee`, loot-specific moves
3. **Damage calculation**:
   - Base attack: `stats.attack + random(0,11)`
   - Technique damage: `floor((baseHit * 2.0 + casterPower * 1.1) + levelBonus)`
   - CE cost reduced by armor/skills
   - Crit chance: base 5% + speed-based + bonuses
4. **Enemy phase** (`runEnemyPhase`, line 3209):
   - `resolveEnemyAction()` picks from `ENEMY_MOVE_POOL` (strike, maul, venom, wither, blind, guard, charge)
   - Defense mitigation: `100 / (100 + min(defense, 300))`
   - Guarding reduces damage by 60%
   - Enemy can expand Domain (sure-hit, ignores guard)
5. **Status effects**: BLEED (DoT), WEAKEN, BLIND, Domain Pressure
6. **Victory**: +4000 XP, +5000 gold, +1 skill point, -5 corruption, possible loot drop (30% chance)
7. **Defeat**: XP loss (50% of needed), RECOVERY status (600 turns / 10 min), corruption +8

### Status Effects
| Effect | Type | Behavior |
|--------|------|----------|
| BLEED | DoT | % of Max_HP per turn |
| WEAKEN | Debuff | Reduces damage output |
| BLIND | Debuff | Reduces accuracy |
| RECOVERY | Penalty | Cannot explore for 10 min |
| Domain Pressure | Debuff | 20% damage reduction for 2 turns |

---

## 5. PVP SYSTEM

### Duel Initiation
- `.ch <@user>`: Creates pending challenge (2 min expiry)
- `.ch-a`: Accepts challenge → `startPvpMatch()`

### PvP Match State
```javascript
{
  p1, p2, turn, round, started, committed: {},
  players: {
    [jid]: { hp, maxhp, ce, maxce, atk, def, spd, guarding, spec, name }
  },
  villageMission?, villageLiberator?
}
```

### Turn Resolution (`handlePvpTurn`, line 2954)
1. **Commit phase**: Each fighter submits a move (stored in `match.committed`)
2. **Validation**: `pvpComputeOffense()` checks CE costs, validates moves
3. **Resolution** (`resolvePvpRound`, line 3006):
   - Phase 1: Defensive/self actions (guard, RCT, jackpot, taunt)
   - Phase 2: Offensive actions resolve in **SPEED order** (higher speed lands first)
   - Both fighters strike before round outcome is decided
   - On double-KO, faster fighter wins

### Damage Formula
- `.attack`: `round(me.atk * variance - you.def * 0.25)`, guard reduces by 55%
- `.technique-n`: `round((move.damage + me.atk * 0.4 - you.def * 0.25) + levelBonus)`
- `.wa`: `round(wa_attack * variance)`
- `.domain`: `round(me.atk * 2 + 200 - you.def * 0.25)`

### Rewards
- Winner: +1500 XP, +500 gold
- Village liberation: +30,000,000 gold if duel was a rebellion mission
- Prison Realm break: Winners with Playful Cloud/Black Rope/Limitless free sealed players
- Culling Game: +50 points for knockout, loser eliminated

---

## 6. CULLING GAME SYSTEM

### Start (`.cg`)
- Entry fee: 500,000,000 K-Coins
- Random colony from `CULLING_COLONIES` (10 colonies)
- All registered players forced into the barrier
- Starting points: 400
- 2-hour timer (`endTime = now + 2h`)
- AI rule generator starts (10-min interval)

### Rules System
- `generateAIRule()`: Random rule from templates (restrictions, modifiers, objectives)
- Players with ≥100 points can propose rules via `.cg-rule <proposal>`
- Max 10 active rules
- AI auto-generates rules every 10 minutes during the game

### Scoring
- PvP knockout: +50 points
- Defeat enemy: +10 points
- Inactivity (70 min): Techniques locked, HP/CE halved for 4 hours

### End (`tickCullingGame`)
- After 2 hours, highest points wins
- Winner: +10M gold, +500K XP
- **Kenjaku event**: #1 leaderboard player sealed in Prison Realm for 24h, all 15 fingers converge on them

### Kenjaku Challenge (`.k-ch`)
- Only available after Culling Game ends
- Special Grade enemy with Brain Transplantation, Curse Manipulation, Domain Expansion
- Defeating Kenjaku: +50M gold, +2M XP

### Culling Game Restrictions
During the Culling Game, players can ONLY use:
- PvP: `.ch`, `.ch-a`, `.ch-end`
- Curse fighting: `.b-curse`
- Combat: `.attack`, `.technique-1..6`, `.guard`, `.flee`, `.wa`, `.qk-1`, `.qk-2`
- Survival: `.heal`, `.fish`
- Info: `.profile`, `.p`, `.stats`, `.inventory`, `.equip`, `.unequip`, `.rct`, `.su`, `.cg-status`, `.cg-leave`

All other commands are blocked.

### Elimination
- When a player dies in combat (curse or PvP), they are immediately eliminated
- Their points are reset to 0
- They receive: `💀 CULLING GAME — ELIMINATED`

---

## 7. SUKUNA RAID SYSTEM

### Finger Mechanics
- 20 fingers scattered across curses (`FINGER_DROP_CHANCE = 1.0`)
- `db.sukunaFingers = { remaining: 20, curses: { 0..19: { name, taken, takenBy } } }`
- `.search`: Hunt for scattered fingers
- `.sukuna`: View finger status
- When all 20 collected → Sukuna awakens automatically

### Raid State (`db.sukuna`)
```javascript
{
  active: true,
  hp: 650000 (or 1,500,000 for 15-finger),
  maxHp, round, startedBy, startedByName,
  players: {}, participants: {}, slain: [],
  _is15Finger: false
}
```

### Raid Flow (`handleRaidTurn`)
1. Player uses `.accept-s` to join (max 30 players)
2. Player actions: `.attack`, `.technique-1..4`, `.domain`, `.su`, `.guard`
3. **Summon auto-strikes** every turn (unless player used `.su`)
4. Sukuna retaliates via `sukunaRetaliate()`:
   - 18% chance of Malevolent Shrine domain expansion (3400 damage to all)
   - Basic strike: 1500 ATK × 0.8–1.4
   - 35% domain chance for 15-finger variant (5000 damage)
5. Dead players removed from raid, broadcast alerts sent

### Rewards
- Normal Sukuna: +500K XP, +1M gold per participant
- 15-Finger Sukuna: +2M XP, +5M gold per participant

### 15-Finger Sukuna
- Triggered by Kenjaku event after Culling Game ends
- HP: 1,500,000 | ATK: 2,500 | Domain: 5,000 damage
- 35% domain chance
- Requires `.accept-s` to join the raid

---

## 8. HEAVENLY RESTRICTION SYSTEM

### Awakening Conditions
- Defeat a **Special Grade** curse using **only** `.wa` (weapon strikes)
- Granted via `.give-hr` mod command

### Effects (`grantHeavenlyRestriction`)
- `heavenly_restriction: true`
- +200 bonus attack, +200 bonus defense
- `.wa_attack = 200` (base weapon strike)
- `Max_CE = 0, CE = 0` (no cursed energy)
- Innate technique replaced with `Heavenly Restriction`
- Skills replaced with HR moves: `heavy_slash`, `clap_smash`, `super_fast_slash`, `divine_axe_slash`, `ricochet_throw`, `parry_counter`
- All loots cleared (`loots = []`)
- All summons released
- **2 random quirks assigned** from `QUIRKS`

### Quirks
| Quirk | Damage | Effect |
|-------|--------|--------|
| `kinetic_impact` | 150 | armor_break |
| `volcanic_veins` | 200 | burn (30/turn × 3) |
| `overclock` | 120 | multi_hit (3 hits) |
| `shatterpoint` | 180 | crit_guaranteed |
| `aero_vortex` | 120 | pull_stun |
| `ironclad_density` | 80 | defend |
| `decay_vector` | 60 | dot_scaling (20/turn × 5) |
| `photon_beam` | 170 | pierce |
| `soundwave_pulse` | 110 | stun |
| `rebound_barrier` | 90 | reflect_setup |

### HR Multi-Weapon System
- HR users can buy multiple weapons (non-HR limited to 1)
- `.waeq <num>` equips a specific weapon
- `.wa1` through `.wa6` switches weapons mid-combat
- `.weapons` lists all owned weapons with slot numbers

### HR Domain Immunity
- HR users cannot use `.domain`
- Enemy domain expansions deal 0 damage to HR users

---

## 9. ECONOMY SYSTEM

### Currency
- **K-Coins**: Primary currency stored in `user.wallet`
- **Bank**: `user.bank` (withdraw/deposit)

### Income Sources
| Source | Amount | Command |
|--------|--------|---------|
| Daily reward | +10,000 | `.daily` |
| Combat victory | +5,000 | Automatic |
| Village mission | 10K–200M | `.v-m-<n>` |
| Dungeon completion | Varies | `.dungeon-next` |
| PvP victory | +500 | Automatic |
| Culling Game win | +10M | Automatic |
| Village taxes | Variable | `.set-taxes` (clan head) |
| Fishing | Consumable | `.fish` (5 min cooldown) |

### Gambling (`.gamble`)
- Colors: red, green, blue, black
- Roll outcomes:
  - < 10%: JACKPOT (×50)
  - < 30%: WIN (×5)
  - < 70%: BREAK EVEN (×0)
  - else: LOSS (×-12)

### Shops
- **Weapon Shop** (`.shops`): 8 cursed tools, 400K–10B coins
- **Armor Shop** (`.shopc`): 11 armor pieces, 1.2K–50M coins
- **Summon Shop** (`.summonshop`): 20 one-of-a-kind summons
- **Player Shops** (`.shop-create`): 1500 coins to create, stock items, other players buy

---

## 10. CLAN & VILLAGE SYSTEM

### Villages
- 500 villages seeded with flower names
- Each has: `population` (500–50K), `wealth` (100K–60M), `colonisedBy`, `tax`, `rebellion`, `mission`
- `.villages` / `.v` lists all villages with occupiers

### Clans
- **Creation cost**: 2,000,000,000 K-Coins
- **Maintenance**: 100,000,000 K-Coins every 30 days
- **Max members**: 50
- **Head title**: "HOKAGE"
- `.clan-create <name>` → `.clan-join <name>` → `.leave-clan`

### Colonization
- Only clan HOKAGE can `.colonise <name>`
- One village per clan
- `.set-taxes <amt>`: Daily tax flows to HOKAGE's wallet
- **Rebellion trigger**: Daily tax > 13,000,000
- `.v-a`: Accept liberation mission (PvP duel against clan head)
- Liberation rewards: 30M gold, village freed

### Village Missions (`.v-m`)
- Randomly generated missions from 8 classes (E to SSS)
- Enemies scale by mission class
- NPC sorcerers may appear for tag-team (`.tag-team`)
- Rewards: 1K–200M gold, 1K–500K XP

---

## 11. SUMMON SYSTEM

### Summon Shop
- 20 one-of-a-kind familiars
- Cost formula: `floor(pl * 15) + 100000`
- Each has: `id`, `name`, `tier`, `pl` (power level), `move`, `effect`

### Binding (`.sbuy-<id>`)
- **One-summon rule enforced**: Buying a new summon releases previous one back to shop
- `db.soldSummons[id]` tracks ownership (sold-out status)
- `setSingleSummon()`: Enforces single summon, calculates battle stats

### Battle Stats (`summonBattleStats`)
- `atk = max(5, floor(user_attack * 0.35))`
- `hp = atk * 5`
- Bound summons auto-strike every combat turn alongside player

### Special Summon: Rika (ID 20)
- Grants infinite CE for 5 minutes (`_rika_mode`)
- `.su` deals massive beam damage: `floor(atk * 0.4) + 5000`

---

## 12. EQUIPMENT SYSTEM

### Weapons (`WEAPON_SHOP`)
- 8 cursed tools (400K–10B coins)
- One weapon per user (HR users can own multiple via `.waeq`)
- Base weapon strike (`.wa`): 6 damage
- HR users: `.wa = 200`, `.attack = 150`
- Special weapons: Prison Realm (seals for 24h), Playful Cloud, Black Rope (break Prison Realm seals)

### Armor (`ARMOR_SHOP`)
- 11 pieces (1.2K–50M coins)
- Rarities: Common → Mythic
- Effects include: XP boost, flee boost, CE reduction, defense scaling, curse damage reduction, Toji ward, Six Eyes immunity, Mastermind revive, Dharma armor stacking, Sukuna shroud

### Rarity System
| Rarity | Color | Stat Mult | Drop Rate |
|--------|-------|-----------|-----------|
| Common | ⚪ | 1.0 | ~30% |
| Uncommon | 🟢 | 1.2 | ~35% |
| Rare | 🔵 | 1.5 | ~20% |
| Epic | 🟣 | 2.0 | ~10% |
| Legendary | 🟡 | 3.0 | ~5% |
| Artifact | 🔴 | 5.0 | ~1% |

### Inventory & Equipment
- `.equip <name>`: Equip from inventory to slot
- `.unequip <slot>`: Return to inventory
- `.upgrade <name>`: +20% stats for 200 gold
- Slots: `weapon`, `armor`, `accessory`, `relic`

---

## 13. ANTI-BAN SYSTEM

### Implementation
The anti-ban protocol **monkey-patches** `sock.sendMessage`:
```javascript
sock.sendMessage = (jid, content, options) => {
  if (!AB.enabled) return _origSendMessage(jid, content, options);
  // Queue message, drain queue with pacing
}
```

### Rate Limits (configurable in `config.json` antiBan)
| Parameter | Default | Purpose |
|-----------|---------|---------|
| `globalMinIntervalMs` | 500ms | Minimum gap between ANY two messages |
| `jidMinIntervalMs` | 900ms | Minimum gap between messages to same chat |
| `perMinuteCap` | 30 | Max messages per minute |
| `maxQueue` | 80 | Max queued messages (drops oldest if exceeded) |
| `jitterMs` | 250 | Random delay added to each send |

### Queue Drain Logic
1. Calculate wait time based on all limits
2. If per-minute cap reached, wait until oldest stamp expires
3. Apply global + per-chat + jitter waits
4. Send via original `_origSendMessage`
5. Track timestamps for rate limiting

### Security Features
- Device JID verification on connect: Prevents session hijacking
- Auto-mod on connect: Bot's own JID auto-added as mod
- Intrusion tracking: `recIntrusion()`, `recMessage()` track spam/ban attempts
- Auto-kick for spam (>15 messages in 5s) or mod bypass attempts (3 strikes)

---

## 14. MOD COMMANDS

### Permission System
- `isOwner(sender)`: Checks `config.owner`
- `isMod(sender)`: Checks `mods` array
- `isBanned(sender)`: Checks `config.banned`

### Mod Intrusion Tracking
- Every mod command logs `recIntrusion(sender, 'mod_bypass', 3)` for unauthorized attempts
- 3 failed attempts → `kickOff()` (ban + group remove)

### Available Mod Commands
| Command | Description |
|---------|-------------|
| `.addmod` | Add mod by mention/reply/JID |
| `.delmod` | Remove mod |
| `.kick` | Remove participant from group |
| `.reset` | Reset user to level 1 (archives loot/summons) |
| `.sres <id>` | Restore summon + pre-reset archive |
| `.give-xp <amt>` | Grant XP to user |
| `.give-g <amt>` | Grant gold to user |
| `.give-gr <grade>` | Set user's grade (special/0-4) |
| `.give-l <level>` | Set user's level |
| `.give-loot <name>` | Grant unique loot (mod copy, doesn't remove from pool) |
| `.give-hr` | Grant Heavenly Restriction |
| `.give-skill <name>` | Grant cross-universe skill |
| `.give-qk <name>` | Grant quirk to HR user |
| `.spawn-sukuna` | Force-spawn Sukuna raid |
| `.end-sukuna` | Banish Sukuna, scatter fingers |
| `.cg-end` | Terminate Culling Game |
| `.unlock-pandora` | Unseal Pandora's Box |
| `.seal-pandora` | Seal Pandora's Box |
| `.reset-a` | **Global reset**: all users to level 1, clear all state |
| `.loot-r` | Remove all loot from user |
| `.rem-loot` | Remove specific loot |
| `.antiban` | Show anti-ban stats |
| `.sf-r` | Scatter all 20 fingers |
| `.sf-g-all` | Give all 20 fingers to caller |
| `.sf-give <@user>` | Give finger to user |

---

## 15. AI SYSTEMS

### AI Rule Generator
- **No actual LLM integration** — uses template-based procedural generation
- `RULE_TEMPLATES`: 15 restrictions, 10 modifiers, 7 objectives
- `generateAIRule()`: Picks random template, fills placeholders with random values
- `startAIRuleGenerator()`: Runs every 10 minutes during Culling Game
- Broadcasts new rule to all groups via `broadcastAllGroups()`

### AI Rule Categories
- **Restrictions**: No technique, CE limits, no domains, no summons, etc.
- **Modifiers**: Damage multipliers, crit rates, guard effectiveness, speed priority
- **Objectives**: Last standing, point targets, survival time, item collection

### Cinematic Descriptions
- `getCinematicPlayerDescription()`: Random action flavor text
- `getCinematicEnemyDescription()`: Random enemy attack flavor text

---

## 16. BROADCAST SYSTEM

### Core Function (`broadcastAllGroups`)
```javascript
async function broadcastAllGroups(sock, text) {
  for (const id of Object.keys(db.enabledGroups || {})) {
    const meta = await sock.groupMetadata(id);
    if (meta.subject.toUpperCase().includes('KEHN')) {
      await sock.sendMessage(id, { text });
    }
  }
}
```

### Broadcast Triggers
| Event | Audience |
|-------|----------|
| Cult ambush | All groups |
| Village liberation | All groups |
| Pandora Kings rampage | All groups |
| Culling Game time up | All groups |
| Kenjaku appears/seals #1 | All groups |
| Sukuna elimination | All groups |
| Sukuna victory | All groups |
| Final battle begins | All groups |
| 15-Finger Sukuna awakens | All groups |
| Quest solved | All groups |
| Kenjaku defeated | All groups |
| New Culling Game rule | All groups |
| AI rule generated | All groups |
| Sukuna banished | All groups |
| Fingers scattered | All groups |
| Pandora's Box unsealed | All groups |
| Pandora's Box sealed | All groups |

### Broadcast Filtering
- Only groups whose `subject` contains "KEHN" (case-insensitive) receive broadcasts
- Uses `db.enabledGroups` (populated by `.approve` command)

### Helper
- `broadcastNow(text)`: Shortcut using `BOT_SOCK`

---

## KEY INTER-SYSTEM INTERACTIONS

1. **Combat ↔ Equipment**: Armor effects (toji_ward, dharma_armor, sukuna_shroud) modify incoming/outgoing damage in `runEnemyPhase()`
2. **Combat ↔ Loot**: Unique loots like `black_sparks`, `limitless_six_eyes`, `jackpot`, `daddyraga` fundamentally alter combat behavior
3. **Culling Game ↔ PvP**: PvP knockouts award +50 points and eliminate the loser from `cg.players`
4. **Culling Game ↔ Sukuna**: After Culling Game ends, #1 player is sealed, triggering 15-Finger Sukuna raid
5. **Village ↔ Clan ↔ PvP**: Liberation missions create PvP duels where winner frees village (30M gold reward)
6. **Heavenly Restriction ↔ Summon**: HR users cannot use summons; all owned summons are released
7. **Dark Continent ↔ Quirks**: Exploring can awaken quirks for HR users; non-HR users learn cross-universe skills
8. **Skills ↔ Combat**: Cross-universe skills (`.sk-1..10`) cost CE, deal damage, usable in PvE, PvP, and Sukuna raid

---

## IMPORTANT BUSINESS LOGIC SUMMARY

- **One-summon rule**: Enforced globally; buying a new summon releases the old one
- **One-loot rule**: Each user can hold exactly one unique loot (except `black_sparks` which is non-unique)
- **Grade scaling**: Enemies scale to player's effective grade, keeping difficulty paired with power
- **Corruption system**: Increases on death, decreases on victory; high corruption enables Cullt ambushes
- **Prison Realm**: 24h seal; only breakable by PvP defeat with specific weapons or Limitless
- **First Blood**: First registered user to defeat a curse within 10 minutes of bot boot gets `courtroom_domain` loot
- **Skill cap**: Max 10 cross-universe skills per user
- **Domain unlock**: Automatic at Grade 2+ (or with Limitless & Six-Eyes)
- **Backup**: Hourly automatic backups, last 24 kept
- **Anti-ban**: Message queuing with rate limiting to prevent WhatsApp bans
- **Broadcast filter**: Only groups with "KEHN" in the name receive global announcements
