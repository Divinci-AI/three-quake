// bot_mind.js -- Jev as the "mind" of Frogbot bots.
//
// Frogbot (frogbot.pak, built with frogbot/jev-hook.patch) stays the body: it
// navigates, aims and fights at tick rate. Every few seconds per bot, this
// module describes the bot's situation to npc-brain's /bot route, which asks
// Jev whom this bot's personality wants to fight and which item, if any, it
// is set on. The answer is written to the bot's jev_enemy / jev_goal fields
// with a short expiry. Frogbot only honours them while fresh, so a slow or
// silent mind hands control straight back to Frogbot's own planner.
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

export const DECIDE_EVERY = 2.5; // seconds of server time between decisions per bot
export const OVERRIDE_TTL = 4; // how long a decision stays in force
export const MAX_ITEMS = 8;
export const ITEM_RANGE = 2200;
const GRUDGE_WINDOW = 90; // seconds a kill is remembered
export const SPEECH_GLOBAL_COOLDOWN = 6; // seconds between any two bot lines
export const SPEECH_BOT_COOLDOWN = 15; // seconds between lines from one bot

const WEAPON_NAMES = [
	[ IT_LIGHTNING, 'thunderbolt' ], [ IT_ROCKET_LAUNCHER, 'rocket launcher' ],
	[ IT_GRENADE_LAUNCHER, 'grenade launcher' ], [ IT_SUPER_NAILGUN, 'super nailgun' ],
	[ 4, 'nailgun' ], [ 2, 'double-barrelled shotgun' ], [ IT_SHOTGUN, 'shotgun' ], [ IT_AXE, 'axe' ],
];

// Items worth a deliberate detour; ammo boxes are Frogbot's business.
const WORTH_A_DETOUR = /^(weapon_|item_armor|item_artifact_)|^item_health$/;

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

export function modeForSlot( modesCvar, order ) {

	const modes = String( modesCvar || '' ).split( ',' ).map( ( m ) => m.trim() ).filter( Boolean );
	const m = modes[ order ];
	return m === 'off' || m === 'random' || m === 'jev' ? m : 'jev';

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
const jevRates = { decisions: 0, focus: 0, goal: 0 };
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

	// Quake names may use the high-bit "red" charset
	return [ ...PR_GetString( e.v.netname ) ].map( ( c ) => String.fromCharCode( c.charCodeAt( 0 ) & 127 ) ).join( '' ).slice( 0, 32 );

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

function situationFor( bot, all ) {

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
	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const e = sv.edicts[ i ];
		if ( ! e || e.free || ! ( ( e.v.flags | 0 ) & FL_ITEM ) ) continue;
		const c = classOf( e );
		if ( ! WORTH_A_DETOUR.test( c ) || PR_GetString( e.v.model ) === '' ) continue;
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

async function decideFor( bot, map, mode ) {

	const all = combatants();
	const { offered, body } = situationFor( bot, all );
	if ( mode === 'random' ) {

		// same kind of override, same options, at Jev's own rate
		const rF = jevRates.decisions ? jevRates.focus / jevRates.decisions : 0.6;
		const rG = jevRates.decisions ? jevRates.goal / jevRates.decisions : 0.85;
		applyDecision( bot, map, {
			focusId: Math.random() < rF ? pick( [ ...offered.opponents.keys() ] ) : null,
			goalId: Math.random() < rG ? pick( [ ...offered.items.keys() ] ) : null,
			taunt: false,
		}, offered, 'random' );
		return;

	}

	const res = await fetch( bot_mind_url.string, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify( body ),
	} );
	const text = await res.text();
	if ( ! res.ok ) throw new Error( `bot mind ${res.status}: ${text.slice( 0, 80 )}` );
	let decision;
	try {

		decision = JSON.parse( text );

	} catch {

		throw new Error( `bot mind returned non-JSON: ${text.slice( 0, 80 )}` );

	}

	applyDecision( bot, map, decision, offered, 'jev' );

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
		if ( goal ) jevRates.goal ++;

	}

	const until = sv.time + OVERRIDE_TTL;
	if ( enemy ) {

		setField( bot, 'jev_enemy', 'entity', EDICT_TO_PROG( enemy.edict ) );
		setField( bot, 'jev_enemy_until', 'float', until );

	}

	if ( goal ) {

		setField( bot, 'jev_goal', 'entity', EDICT_TO_PROG( goal.edict ) );
		setField( bot, 'jev_goal_until', 'float', until );

	}

	const st = bots.get( bot.index );
	if ( st && typeof decision.persona === 'string' && /^[a-z]{1,16}$/.test( decision.persona ) ) st.persona = decision.persona;
	if ( st && decision.taunt && mode === 'jev' ) speak( bot, st, 'taunt', null );

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
			st = { next: sv.time + Math.random() * DECIDE_EVERY, inFlight: false, alive: e.v.health > 0, frags: Math.round( e.v.frags ), isBot };
			if ( isBot ) {

				st.mode = modeForSlot( bot_mind_modes.string, joinOrder ++ );
				st.persona = personaKeyFor( name );

			}

			bots.set( e.index, st );
			stats.set( e.index, {
				name, isBot, mode: st.mode ?? 'human', persona: st.persona ?? null,
				frags: 0, deaths: 0, kills: 0, suicides: 0, killedBy: {},
				grudgeSamples: 0, grudgeOnKiller: 0, grudgeChance: 0,
				pickups: { armor: 0, megahealth: 0, weapon: 0, powerup: 0 },
				decisions: 0, focusApplied: 0, goalApplied: 0, firstSeen: sv.time,
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

			const victim = PROG_TO_EDICT( e.v.enemy | 0 );
			speak( e, st, 'frag', victim && victim !== sv.edicts[ 0 ] ? plainName( victim ) : null );

		}

		st.frags = frags;
		if ( ! st.alive && alive ) st.next = sv.time; // just respawned: decide now
		st.alive = alive;

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

		if ( ! isBot || ! alive || st.inFlight || sv.time < st.next || st.mode === 'off' ) continue;
		st.inFlight = true;
		st.next = sv.time + DECIDE_EVERY;
		decideFor( e, map, st.mode )
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

	return { map: statsMap, time: sv.time, jevRates: { ...jevRates }, bots: [ ...stats.values() ].map( ( b ) => ( { ...b, killedBy: { ...b.killedBy }, pickups: { ...b.pickups } } ) ) };

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
	Cmd_AddCommand( 'botmatch', Botmatch_f );
	if ( ! timer ) timer = setInterval( () => {

		try {

			tick();

		} catch ( err ) {

			Con_Printf( '%s', `[bot-mind] tick: ${err.message}\n` );

		}

	}, 250 );

}
