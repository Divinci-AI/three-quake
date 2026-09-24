// bot_mind.js -- Jev as the "mind" of Frogbot bots.
//
// Frogbot (frogbot.pak, built with frogbot/jev-hook.patch) stays the body: it
// navigates, aims and fights at tick rate. On a few EVENTS per bot (respawn,
// its own frag, otherwise a 30 s refresh) this module describes the bot's
// situation to npc-brain's /bot route, which asks Jev whom this personality
// wants to fight and, for a greedy bot, which high-value item it is set on.
// The answer is written to jev_enemy / jev_goal and HELD until the next
// decision, or until its target dies or the item is taken; then Frogbot's own
// planner takes over again.
//
// v1 asked every 2.5 s with a 4 s expiry: ~72 calls per bot per 3-minute
// match, and the goal changed on half of them, so the bot was re-routed
// before it ever reached anything. See docs/RESEARCH_NOTES.md.
//
// The world keeps moving while the request is in flight, so every answer is
// re-validated against the live entities before it is written.

import { cvar_t, Cvar_RegisterVariable } from './cvar.js';
import { Con_Printf, MSG_WriteByte, MSG_WriteString } from './common.js';
import { svc_print, svc_stufftext } from './protocol.js';
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cbuf_AddText } from './cmd.js';
import { cls } from './client.js';
import { npc_brain_url } from './npc_talk.js';
import { EDICT_TO_PROG, PROG_TO_EDICT, PR_GetString } from './progs.js';
import { GetEdictFieldValue } from './pr_edict.js';
import { sv, svs, FL_ITEM } from './server.js';
import {
	IT_SHOTGUN, IT_SUPER_NAILGUN, IT_GRENADE_LAUNCHER, IT_ROCKET_LAUNCHER, IT_LIGHTNING, IT_AXE,
} from './quakedef.js';

export const bot_mind = new cvar_t( 'bot_mind', '1' );
export const bot_mind_url = new cvar_t( 'bot_mind_url', 'http://127.0.0.1:8797/bot' );
// Per-bot minds for benchmarking, by join order: e.g. "jev,off,random".
// Empty = every bot uses Jev. off = pure Frogbot. random = same kind of
// override from the same offered options, applied at Jev's own running rate.
export const bot_mind_modes = new cvar_t( 'bot_mind_modes', '' );
export const bot_voice = new cvar_t( 'bot_voice', '1' );

// Per-bot personalities by join order ("greedy,bully,..."), or one key for
// every bot. Empty = derived from the bot's name, as in normal play. The
// benchmark pins these: a name-derived persona is confounded with the mind.
export const bot_mind_personas = new cvar_t( 'bot_mind_personas', '' );
// Whether greedy bots are steered toward items at all. Off by default: in the
// v2 pilot, greedy bots grabbed 1.50 high-value items/min on plain Frogbot and
// 0.56/min under Jev steering (docs/RESEARCH_NOTES.md, 09-24).
export const bot_mind_goals = new cvar_t( 'bot_mind_goals', '0' );
// Jev decisions per bot per match, hard cap (the random control obeys it too)
export const bot_mind_budget = new cvar_t( 'bot_mind_budget', '20' );

export const REFRESH_EVERY = 30; // seconds: a decision with no event since goes stale
export const COMMIT_TTL = REFRESH_EVERY + 5; // outlives the refresh; events release it earlier
export const MAX_ITEMS = 6;
export const ITEM_RANGE = 2200;
const GRUDGE_WINDOW = 90; // seconds a kill is remembered
export const SPEECH_GLOBAL_COOLDOWN = 6; // seconds between any two bot lines
export const SPEECH_BOT_COOLDOWN = 15; // seconds between lines from one bot

const WEAPON_NAMES = [
	[ IT_LIGHTNING, 'thunderbolt' ], [ IT_ROCKET_LAUNCHER, 'rocket launcher' ],
	[ IT_GRENADE_LAUNCHER, 'grenade launcher' ], [ IT_SUPER_NAILGUN, 'super nailgun' ],
	[ 4, 'nailgun' ], [ 2, 'double-barrelled shotgun' ], [ IT_SHOTGUN, 'shotgun' ], [ IT_AXE, 'axe' ],
];

// Items worth a deliberate detour, and only for a greedy bot: the big
// armours, the two best weapons, powerups and megahealth. Everything else is
// Frogbot's business.
const HIGH_VALUE = /^(item_armor2|item_armorInv|weapon_rocketlauncher|weapon_lightning|item_artifact_)/;
export const ITEM_PERSONAS = new Set( [ 'greedy' ] );

export function highValue( classname, spawnflags ) {

	return HIGH_VALUE.test( classname ) || ( classname === 'item_health' && ( spawnflags & 2 ) !== 0 );

}

const WEAPON_BIT = {
	weapon_supershotgun: 2, weapon_nailgun: 4, weapon_supernailgun: IT_SUPER_NAILGUN,
	weapon_grenadelauncher: IT_GRENADE_LAUNCHER, weapon_rocketlauncher: IT_ROCKET_LAUNCHER, weapon_lightning: IT_LIGHTNING,
};
const ARMOR_VALUE = { item_armor1: 100, item_armor2: 150, item_armorInv: 200 };
const H_MEGA = 2; // item_health spawnflag

// Whether picking this up would do anything for the bot RIGHT NOW. This is a
// game rule, so it lives in code: offering Jev an item the bot cannot take
// (a health box at full health) made a "greedy" bot camp it for a minute.
export function canUse( classname, spawnflags, bot ) {

	if ( classname === 'item_health' )
		return ( spawnflags & H_MEGA ) ? bot.health < 250 : bot.health < 100;
	if ( classname in WEAPON_BIT ) return ! ( ( bot.items | 0 ) & WEAPON_BIT[ classname ] );
	if ( classname in ARMOR_VALUE ) return bot.armorvalue < ARMOR_VALUE[ classname ];
	return true; // artifacts (quad, pent, ring) are always worth it

}

//============================================================================
// Pure helpers (exported for tests)
//============================================================================

// Same order and hash as npc-brain/bots.ts BOT_PERSONAS / personaFor, so a
// bot's personality is known even when its mind is off or random.
export const PERSONA_KEYS = [ 'vindictive', 'greedy', 'showoff', 'cautious', 'bully' ];

export function personaKeyFor( name ) {

	let h = 0;
	for ( const c of name ) h = ( h * 31 + c.charCodeAt( 0 ) ) >>> 0;
	return PERSONA_KEYS[ h % PERSONA_KEYS.length ];

}

export function personaForSlot( personasCvar, order, name ) {

	const keys = String( personasCvar || '' ).split( ',' ).map( ( k ) => k.trim() ).filter( Boolean );
	const k = keys.length === 1 ? keys[ 0 ] : keys[ order ];
	return PERSONA_KEYS.includes( k ) ? k : personaKeyFor( name );

}

export function modeForSlot( modesCvar, order ) {

	const modes = String( modesCvar || '' ).split( ',' ).map( ( m ) => m.trim() ).filter( Boolean );
	const m = modes[ order ];
	return m === 'off' || m === 'random' || m === 'jev' || m === 'so1' ? m : 'jev';

}

// Attribute each death this tick to the one combatant whose frags went up,
// when that is unambiguous. Frogbot's `enemy` at death is only who the victim
// was TARGETING, which is not who killed it.
export function attributeKills( deaths, fragGainers ) {

	if ( deaths.length === 1 && fragGainers.length === 1 && fragGainers[ 0 ] !== deaths[ 0 ] )
		return [ { victim: deaths[ 0 ], killer: fragGainers[ 0 ] } ];
	return [];

}

export function pickupCategory( classname, spawnflags ) {

	if ( classname.startsWith( 'item_armor' ) ) return 'armor';
	if ( classname === 'item_health' && ( spawnflags & 2 ) ) return 'megahealth';
	if ( classname.startsWith( 'weapon_' ) ) return 'weapon';
	if ( classname.startsWith( 'item_artifact_' ) ) return 'powerup';
	return null;

}

// Quake names use a 256-glyph charset: the high bit is the red copy, 18-27
// are gold digits and 16/17 brackets. Map to plain ASCII and drop the rest,
// so the engine and the brain hash the SAME string for a bot's personality
// (v1 kept raw control bytes here while the brain stripped them).
export function quakeToAscii( raw ) {

	let out = '';
	for ( const ch of raw ) {

		const c = ch.charCodeAt( 0 ) & 127;
		if ( c >= 32 && c < 127 ) out += String.fromCharCode( c );
		else if ( c >= 18 && c <= 27 ) out += String( c - 18 );
		else if ( c === 16 ) out += '[';
		else if ( c === 17 ) out += ']';

	}

	return out.trim();

}

// Whether a bot should ask its mind now: on respawn, right after its own
// frag, or when its last decision has gone stale; never past its budget.
export function shouldDecide( { want, now, next, used, budget } ) {

	if ( used >= budget ) return false;
	return want !== null || now >= next;

}

export function weaponName( bits ) {

	for ( const [ bit, name ] of WEAPON_NAMES ) if ( ( bits | 0 ) === bit ) return name;
	return 'unknown';

}

export function distance( a, b ) {

	return Math.round( Math.hypot( a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ) );

}

// Validate the brain's answer against the current world. Returns the entities
// to write, or null for "let Frogbot decide". An id the engine did not offer,
// or one whose entity has since changed, is dropped.
export function resolveDecision( decision, offered, lookup ) {

	const out = { enemy: null, goal: null };
	if ( ! decision || typeof decision !== 'object' ) return out;

	if ( typeof decision.focusId === 'string' && offered.opponents.has( decision.focusId ) ) {

		const e = lookup( decision.focusId );
		if ( e && ! e.free && e.v.health > 0 && e.classname === offered.opponents.get( decision.focusId ) ) out.enemy = e;

	}

	if ( typeof decision.goalId === 'string' && offered.items.has( decision.goalId ) ) {

		const e = lookup( decision.goalId );
		if ( e && ! e.free && e.model !== '' && e.classname === offered.items.get( decision.goalId ) ) out.goal = e;

	}

	return out;

}

//============================================================================
// Engine glue
//============================================================================

const bots = new Map(); // edict index -> { name, next, inFlight, alive }
let joinOrder = 0;
// benchmark statistics, per bot edict index; reset on a new map
const stats = new Map();
let statsMap = '';
let lastTickTime = 0;
const itemPresent = new Map(); // item edict index -> had a model last tick
// Jev's running override rates, so the random control intervenes as often
const jevRates = { decisions: 0, focus: 0, goalAsked: 0, goal: 0 };
let lastSpeechAny = - Infinity;
let speechInFlight = false;
const session = Math.random().toString( 36 ).slice( 2, 10 );
const grudges = new Map(); // `${botIdx}` -> [{ killer: idx, at: time }]
let timer = null;

function classOf( e ) {

	return PR_GetString( e.v.classname );

}

function setField( ent, name, kind, value ) {

	const f = GetEdictFieldValue( ent, name );
	if ( ! f ) return false;
	if ( kind === 'entity' ) f.accessor.setInt32( f.ofs, value );
	else f.accessor.setFloat( f.ofs, value );
	return true;

}

function plainName( e ) {

	return quakeToAscii( PR_GetString( e.v.netname ) ).slice( 0, 32 );

}

function combatants() {

	const list = [];
	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const e = sv.edicts[ i ];
		if ( ! e || e.free ) continue;
		const c = classOf( e );
		const humanSlot = c === 'player' && i <= ( svs.maxclients || 1 ) && svs.clients[ i - 1 ] && svs.clients[ i - 1 ].active;
		if ( c === 'frogbot' || humanSlot ) list.push( e );

	}

	return list;

}

function situationFor( bot, all, persona ) {

	const me = bot.index;
	const now = sv.time;
	const recent = ( grudges.get( me ) || [] ).filter( ( g ) => now - g.at < GRUDGE_WINDOW );
	grudges.set( me, recent );

	const offered = { opponents: new Map(), items: new Map() };
	const opponents = [];
	for ( const o of all ) {

		if ( o === bot || o.v.health <= 0 ) continue;
		if ( ( o.v.flags | 0 ) & 128 ) continue; // notarget: an observer, not an opponent
		const id = 'p' + o.index;
		offered.opponents.set( id, classOf( o ) );
		opponents.push( {
			id, name: plainName( o ) || 'player', frags: Math.round( o.v.frags ),
			distance: distance( bot.v.origin, o.v.origin ),
			killedMeRecently: recent.filter( ( g ) => g.killer === o.index ).length,
		} );

	}

	const items = [];
	const wantsItems = bot_mind_goals.value !== 0 && ITEM_PERSONAS.has( persona );
	for ( let i = 1; wantsItems && i < sv.num_edicts; i ++ ) {

		const e = sv.edicts[ i ];
		if ( ! e || e.free || ! ( ( e.v.flags | 0 ) & FL_ITEM ) ) continue;
		const c = classOf( e );
		if ( ! highValue( c, e.v.spawnflags | 0 ) || PR_GetString( e.v.model ) === '' ) continue;
		if ( ! canUse( c, e.v.spawnflags | 0, { health: bot.v.health, items: bot.v.items, armorvalue: bot.v.armorvalue } ) ) continue;
		const d = distance( bot.v.origin, e.v.origin );
		if ( d > ITEM_RANGE ) continue;
		items.push( { id: 'i' + i, item: PR_GetString( e.v.netname ) || c, distance: d, c } );

	}

	items.sort( ( a, b ) => a.distance - b.distance );
	const nearest = items.slice( 0, MAX_ITEMS );
	for ( const it of nearest ) offered.items.set( it.id, it.c );

	return {
		offered,
		body: {
			persona,
			bot: {
				name: plainName( bot ) || 'bot', health: Math.round( bot.v.health ), armor: Math.round( bot.v.armorvalue ),
				weapon: weaponName( bot.v.weapon ), frags: Math.round( bot.v.frags ),
			},
			opponents,
			items: nearest.map( ( { c: _c, ...rest } ) => rest ),
		},
	};

}

function lookupById( id ) {

	const idx = Number( id.slice( 1 ) );
	const e = sv.edicts[ idx ];
	if ( ! e ) return null;
	return { free: e.free, v: e.v, classname: classOf( e ), model: PR_GetString( e.v.model ), edict: e };

}

function pick( list ) {

	return list.length ? list[ Math.floor( Math.random() * list.length ) ] : null;

}

async function decideFor( bot, map, mode, persona ) {

	const all = combatants();
	const { offered, body } = situationFor( bot, all, persona );
	if ( mode === 'random' ) {

		// same kind of override, same options, same triggers, at Jev's own rate
		const rF = jevRates.decisions ? jevRates.focus / jevRates.decisions : 0.8;
		const rG = jevRates.goalAsked ? jevRates.goal / jevRates.goalAsked : 0.8;
		applyDecision( bot, map, {
			focusId: Math.random() < rF ? pick( [ ...offered.opponents.keys() ] ) : null,
			goalId: offered.items.size && Math.random() < rG ? pick( [ ...offered.items.keys() ] ) : null,
		}, offered, 'random' );
		return;

	}

	const res = await fetch( bot_mind_url.string, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( { ...body, mind: mode } ),
	} );
	const text = await res.text();
	if ( ! res.ok ) throw new Error( `bot mind ${res.status}: ${text.slice( 0, 80 )}` );
	let decision;
	try {

		decision = JSON.parse( text );

	} catch {

		throw new Error( `bot mind returned non-JSON: ${text.slice( 0, 80 )}` );

	}

	// "Frogbot decides" because the mind timed out, errored or hit a ceiling is
	// not a decision: keep the current commitment and count it separately.
	if ( decision.source !== mode ) {

		const sb = stats.get( bot.index );
		if ( sb ) sb.mindFailures ++;
		return;

	}

	applyDecision( bot, map, decision, offered, mode );

}

function applyDecision( bot, map, decision, offered, mode ) {

	// the world moved on while we waited
	if ( ! sv.active || sv.name !== map || bot.free || bot.v.health <= 0 || classOf( bot ) !== 'frogbot' ) return;

	const { enemy, goal } = resolveDecision( decision, offered, lookupById );
	const sb = stats.get( bot.index );
	if ( sb ) {

		sb.decisions ++;
		if ( enemy ) sb.focusApplied ++;
		if ( goal ) sb.goalApplied ++;

	}

	if ( mode === 'jev' ) {

		jevRates.decisions ++;
		if ( enemy ) jevRates.focus ++;
		if ( offered.items.size ) jevRates.goalAsked ++;
		if ( goal ) jevRates.goal ++;

	}

	// A new decision replaces the old one outright; "no preference" releases it.
	const st = bots.get( bot.index );
	const until = sv.time + COMMIT_TTL;
	setField( bot, 'jev_enemy', 'entity', enemy ? EDICT_TO_PROG( enemy.edict ) : 0 );
	setField( bot, 'jev_enemy_until', 'float', enemy ? until : 0 );
	setField( bot, 'jev_goal', 'entity', goal ? EDICT_TO_PROG( goal.edict ) : 0 );
	setField( bot, 'jev_goal_until', 'float', goal ? until : 0 );
	if ( st ) {

		st.commitEnemy = enemy ? enemy.edict.index : 0;
		st.commitGoal = goal ? goal.edict.index : 0;
		if ( sb && goal && st.lastGoal && st.lastGoal !== st.commitGoal ) sb.goalSwitches ++;
		if ( goal ) st.lastGoal = st.commitGoal;

	}

}

// A held decision whose target is gone hands control back to Frogbot now,
// instead of steering the bot at a corpse or an empty item spot.
function releaseStale( bot, st ) {

	if ( st.commitEnemy ) {

		const e = sv.edicts[ st.commitEnemy ];
		if ( ! e || e.free || e.v.health <= 0 ) {

			setField( bot, 'jev_enemy_until', 'float', 0 );
			st.commitEnemy = 0;

		}

	}

	if ( st.commitGoal ) {

		const g = sv.edicts[ st.commitGoal ];
		if ( ! g || g.free || PR_GetString( g.v.model ) === '' ) {

			setField( bot, 'jev_goal_until', 'float', 0 );
			st.commitGoal = 0;

		}

	}

}

function broadcast( svc, text ) {

	for ( const c of svs.clients ) {

		if ( ! c || ! c.active || ! c.message ) continue;
		MSG_WriteByte( c.message, svc );
		MSG_WriteString( c.message, text );

	}

}

// A bot says one line through its personality's Divinci player release.
function speak( bot, st, event, opponent ) {

	if ( ! st.persona || speechInFlight || bot_voice.value === 0 ) return;
	if ( sv.time - lastSpeechAny < SPEECH_GLOBAL_COOLDOWN || sv.time - ( st.lastSpoke ?? - Infinity ) < SPEECH_BOT_COOLDOWN ) return;
	lastSpeechAny = sv.time;
	st.lastSpoke = sv.time;
	speechInFlight = true;
	const map = sv.name;
	const name = plainName( bot ) || 'bot';
	fetch( npc_brain_url.string, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( {
			character: 'bot_' + st.persona, event,
			conversationId: `${session}:${map}:bot:${bot.index}`,
			context: { map, distance: 0, monsterHealth: Math.max( 0, Math.round( bot.v.health ) ), playerHealth: 0, hostileToPlayer: true, ...( opponent ? { opponent } : {} ) },
		} ),
	} ).then( async ( res ) => {

		const text = await res.text();
		if ( ! res.ok ) throw new Error( `bot voice ${res.status}: ${text.slice( 0, 80 )}` );
		let reply;
		try {

			reply = JSON.parse( text );

		} catch {

			throw new Error( 'bot voice returned non-JSON' );

		}

		if ( sv.name !== map ) return;
		const line = typeof reply.line === 'string' ? reply.line.replace( /[^\x20-\x7e]/g, ' ' ).trim().slice( 0, 160 ) : '';
		if ( ! line ) return;
		broadcast( svc_print, `${name}: ${line}\n` );
		if ( typeof reply.audioId === 'string' && /^[a-f0-9]{32}$/.test( reply.audioId ) )
			broadcast( svc_stufftext, `npc_speak ${reply.audioId} 0.8\n` );

	} ).catch( ( err ) => Con_Printf( '%s', `[bot-mind] ${err.message}\n` ) )
		.finally( () => {

			speechInFlight = false;

		} );

}

function tick() {

	if ( ! sv.active || ! sv.edicts || bot_mind.value === 0 ) return;
	const map = sv.name;
	// new map, or the same map restarted (server time went backwards)
	const restarted = sv.time < lastTickTime;
	lastTickTime = sv.time;
	if ( statsMap !== map || restarted ) {

		stats.clear();
		itemPresent.clear();
		bots.clear();
		grudges.clear();
		joinOrder = 0;
		statsMap = map;

	}

	const seen = new Set();
	const all = combatants();
	const deaths = [];
	const fragGainers = [];

	for ( const e of all ) {

		const isBot = classOf( e ) === 'frogbot';
		let st = bots.get( e.index );
		if ( ! st ) {

			const name = plainName( e ) || 'bot';
			st = { next: sv.time + REFRESH_EVERY, want: 'spawn', used: 0, inFlight: false, alive: e.v.health > 0, frags: Math.round( e.v.frags ), isBot, commitEnemy: 0, commitGoal: 0, lastGoal: 0 };
			if ( isBot ) {

				st.slot = joinOrder;
				st.mode = modeForSlot( bot_mind_modes.string, joinOrder );
				st.persona = personaForSlot( bot_mind_personas.string, joinOrder ++, name );

			}

			bots.set( e.index, st );
			stats.set( e.index, {
				name, isBot, mode: st.mode ?? 'human', persona: st.persona ?? null, slot: st.slot ?? null,
				// mechanism check: while a focus is held, how often is Frogbot's
				// actual enemy that focus? (ticks are 250 ms)
				focusHeldTicks: 0, focusOnTargetTicks: 0,
				frags: 0, deaths: 0, kills: 0, suicides: 0, killedBy: {},
				grudgeSamples: 0, grudgeOnKiller: 0, grudgeChance: 0,
				pickups: { armor: 0, megahealth: 0, weapon: 0, powerup: 0 },
				decisions: 0, mindFailures: 0, focusApplied: 0, goalApplied: 0, goalSwitches: 0, budgetExhausted: false,
				triggers: { spawn: 0, frag: 0, refresh: 0 }, firstSeen: sv.time,
			} );

		}

		seen.add( e.index );
		const sb = stats.get( e.index );
		const alive = e.v.health > 0;
		const frags = Math.round( e.v.frags );
		if ( frags > st.frags ) fragGainers.push( e.index );
		if ( frags < st.frags ) sb.suicides += st.frags - frags;
		sb.frags = frags;

		if ( st.alive && ! alive ) {

			deaths.push( e.index );
			sb.deaths ++;

		}

		if ( isBot && frags > st.frags ) {

			st.want = 'frag';
			const victim = PROG_TO_EDICT( e.v.enemy | 0 );
			speak( e, st, 'frag', victim && victim !== sv.edicts[ 0 ] ? plainName( victim ) : null );

		}

		st.frags = frags;
		if ( ! st.alive && alive ) st.want = 'spawn';
		st.alive = alive;
		if ( isBot && alive ) {

			releaseStale( e, st );
			if ( st.commitEnemy ) {

				sb.focusHeldTicks ++;
				if ( PROG_TO_EDICT( e.v.enemy | 0 ) === sv.edicts[ st.commitEnemy ] ) sb.focusOnTargetTicks ++;

			}

		}

		// grudge adherence: is it fighting the one who last killed it?
		if ( isBot && alive ) {

			const recent = ( grudges.get( e.index ) || [] ).filter( ( g ) => sv.time - g.at < GRUDGE_WINDOW );
			const last = recent[ recent.length - 1 ];
			const killerEnt = last ? sv.edicts[ last.killer ] : null;
			if ( killerEnt && ! killerEnt.free && killerEnt.v.health > 0 ) {

				const opponents = all.filter( ( o ) => o !== e && o.v.health > 0 && ! ( ( o.v.flags | 0 ) & 128 ) ).length;
				sb.grudgeSamples ++;
				if ( opponents > 0 ) sb.grudgeChance += 1 / opponents;
				if ( PROG_TO_EDICT( e.v.enemy | 0 ) === killerEnt ) sb.grudgeOnKiller ++;

			}

		}

		if ( ! isBot || ! alive || st.inFlight || st.mode === 'off' ) continue;
		const budget = Math.max( 0, bot_mind_budget.value | 0 );
		if ( ! shouldDecide( { want: st.want, now: sv.time, next: st.next, used: st.used, budget } ) ) {

			if ( st.used >= budget ) sb.budgetExhausted = true;
			continue;

		}

		sb.triggers[ st.want ?? 'refresh' ] ++;
		st.want = null;
		st.used ++;
		st.inFlight = true;
		st.next = sv.time + REFRESH_EVERY;
		decideFor( e, map, st.mode, st.persona )
			.catch( ( err ) => Con_Printf( '%s', `[bot-mind] ${err.message}\n` ) )
			.finally( () => {

				st.inFlight = false;

			} );

	}

	// who killed whom, when this tick makes it unambiguous
	for ( const { victim, killer } of attributeKills( deaths, fragGainers ) ) {

		const vs = stats.get( victim );
		const ks = stats.get( killer );
		if ( vs ) vs.killedBy[ ks ? ks.name : killer ] = ( vs.killedBy[ ks ? ks.name : killer ] || 0 ) + 1;
		if ( ks ) ks.kills ++;
		const list = grudges.get( victim ) || [];
		list.push( { killer, at: sv.time } );
		grudges.set( victim, list );
		const vst = bots.get( victim );
		const kEnt = sv.edicts[ killer ];
		if ( vst && vst.isBot && kEnt ) speak( sv.edicts[ victim ], vst, 'death', plainName( kEnt ) );

	}

	// high-value pickups: an item that just vanished goes to the nearest combatant
	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const it = sv.edicts[ i ];
		if ( ! it || it.free || ! ( ( it.v.flags | 0 ) & FL_ITEM ) ) continue;
		const cat = pickupCategory( classOf( it ), it.v.spawnflags | 0 );
		if ( ! cat ) continue;
		const present = PR_GetString( it.v.model ) !== '';
		if ( itemPresent.get( i ) === true && ! present ) {

			let best = null;
			let bestD = 96;
			for ( const c of all ) {

				const d = distance( c.v.origin, it.v.origin );
				if ( d < bestD ) {

					best = c;
					bestD = d;

				}

			}

			if ( best && stats.get( best.index ) ) stats.get( best.index ).pickups[ cat ] ++;

		}

		itemPresent.set( i, present );

	}

	for ( const idx of bots.keys() ) if ( ! seen.has( idx ) ) bots.delete( idx );

}

export function BotMind_Stats() {

	return { map: statsMap, time: sv.time, jevRates: { ...jevRates }, bots: [ ...stats.values() ].map( ( b ) => ( { ...b, killedBy: { ...b.killedBy }, pickups: { ...b.pickups }, triggers: { ...b.triggers } } ) ) };

}

/*
botmatch [map] [bots]

One command for a bot deathmatch. maxplayers cannot change while a server is
running, so typing "maxplayers 4; deathmatch 3; map e1m1" into a game that is
already running quietly leaves it single player, and Frogbot's addbot then
refuses ("cannot add bots in single player"). This disconnects first, and
spaces the addbots out, because several impulses in one frame overwrite
each other and only one bot joins.
*/
let botmatchTimer = null;

function Botmatch_f() {

	const map = Cmd_Argc() > 1 ? Cmd_Argv( 1 ).replace( /[^a-z0-9_]/gi, '' ) : 'e1m1';
	const count = Math.max( 1, Math.min( 3, Number( Cmd_Argv( 2 ) ) || 3 ) );
	if ( botmatchTimer ) clearInterval( botmatchTimer );

	Cbuf_AddText( `disconnect\nmaxplayers ${count + 1}\ndeathmatch 3\nmap ${map}\n` );
	let added = 0;
	let settle = 0;
	botmatchTimer = setInterval( () => {

		if ( ! sv.active || sv.name !== map || cls.signon !== 4 ) return;
		if ( settle ++ < 4 ) return; // let the map finish spawning (~1 s)
		Cbuf_AddText( 'addbot\n' );
		if ( ++ added >= count ) {

			clearInterval( botmatchTimer );
			botmatchTimer = null;

		}

	}, 1500 );

}

export function BotMind_Init() {

	Cvar_RegisterVariable( bot_mind );
	Cvar_RegisterVariable( bot_mind_url );
	Cvar_RegisterVariable( bot_mind_modes );
	Cvar_RegisterVariable( bot_voice );
	Cvar_RegisterVariable( bot_mind_budget );
	Cvar_RegisterVariable( bot_mind_personas );
	Cvar_RegisterVariable( bot_mind_goals );
	Cmd_AddCommand( 'botmatch', Botmatch_f );
	if ( ! timer ) timer = setInterval( () => {

		try {

			tick();

		} catch ( err ) {

			Con_Printf( '%s', `[bot-mind] tick: ${err.message}\n` );

		}

	}, 250 );

}
