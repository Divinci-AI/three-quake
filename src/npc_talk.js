// npc_talk.js -- talk to the monster you are looking at.
//
// `talk <words>` picks the nearest living monster in front of the player,
// sends what the player said plus a little game state to an external
// "brain" service, and shows the reply as a centerprint. The brain may also
// ask for one ACTION from a fixed allowlist; the engine, not the model,
// decides what that action is allowed to do.
//
// The request is async and the game keeps running while it is in flight, so
// every reply is re-validated against the live world before it is applied:
// the map may have changed, the monster may be dead, or its edict may have
// been reused by something else.

import { Cmd_AddCommand, Cmd_Args, Cmd_Argv, Cmd_ForwardToServer, cmd_source, src_command } from './cmd.js';
import { cvar_t, Cvar_RegisterVariable, Cvar_VariableValue } from './cvar.js';
import { MSG_WriteByte, MSG_WriteString, Con_Printf } from './common.js';
import { AngleVectors } from './mathlib.js';
import { svc_centerprint, svc_print, svc_stufftext } from './protocol.js';
import { EDICT_TO_PROG, PR_GetString, pr_global_struct } from './progs.js';
import { PR_ExecuteProgram } from './pr_exec.js';
import { GetEdictFieldValue } from './pr_edict.js';
import { sv, svs, host_client, FL_MONSTER } from './server.js';
import { sv_player } from './sv_phys.js';

export const npc_brain_url = new cvar_t( 'npc_brain_url', 'http://127.0.0.1:8797/npc' );

export const TALK_RANGE = 700;
// cos(~50deg): the monster has to be roughly in front of you
export const TALK_MIN_DOT = 0.64;
export const MAX_SAY_LENGTH = 300;
export const MAX_LINE_LENGTH = 200;
export const HISTORY_TURNS = 6;
export const ALLOWED_ACTIONS = [ 'none', 'attack' ];

// key `${map}:${edictIndex}:${classname}` -> [{ speaker, text }]
const histories = new Map();
let historyMap = '';
// one conversation in flight per client, keyed by the client object
const pending = new WeakSet();

//============================================================================
// Pure helpers (exported for tests)
//============================================================================

export function pickTalkTarget( edicts, numEdicts, player, getClassname ) {

	const forward = [ 0, 0, 0 ];
	AngleVectors( player.v.v_angle, forward, [ 0, 0, 0 ], [ 0, 0, 0 ] );

	const eye = player.v.origin;
	let best = null;
	let bestDist = Infinity;

	for ( let i = 1; i < numEdicts; i ++ ) {

		const ent = edicts[ i ];
		if ( ! ent || ent.free || ent === player )
			continue;
		if ( ! ( ( ent.v.flags | 0 ) & FL_MONSTER ) || ent.v.health <= 0 )
			continue;

		const o = ent.v.origin;
		const d = [ o[ 0 ] - eye[ 0 ], o[ 1 ] - eye[ 1 ], o[ 2 ] - eye[ 2 ] ];
		const dist = Math.hypot( d[ 0 ], d[ 1 ], d[ 2 ] );
		if ( dist > TALK_RANGE || dist === 0 )
			continue;

		const dot = ( d[ 0 ] * forward[ 0 ] + d[ 1 ] * forward[ 1 ] + d[ 2 ] * forward[ 2 ] ) / dist;
		if ( dot < TALK_MIN_DOT )
			continue;

		if ( dist < bestDist ) {

			best = { ent, classname: getClassname( ent ), distance: Math.round( dist ) };
			bestDist = dist;

		}

	}

	return best;

}

// Validate whatever the brain sent back. Anything malformed becomes a
// harmless "no reply" instead of reaching the game.
export function sanitizeReply( raw ) {

	if ( ! raw || typeof raw !== 'object' )
		return null;

	let line = typeof raw.line === 'string' ? raw.line : '';
	// Quake's charset: printable ASCII only; newlines are ours to place
	line = line.replace( /[^\x20-\x7e]/g, ' ' ).replace( /\s+/g, ' ' ).trim();
	if ( line.length > MAX_LINE_LENGTH )
		line = line.slice( 0, MAX_LINE_LENGTH - 3 ).trimEnd() + '...';
	if ( line.length === 0 )
		return null;

	const action = ALLOWED_ACTIONS.includes( raw.action ) ? raw.action : 'none';
	// only ever interpolated into a console command, so it must be exactly hex
	const audioId = typeof raw.audioId === 'string' && /^[a-f0-9]{32}$/.test( raw.audioId ) ? raw.audioId : null;
	return { line, action, audioId };

}

// centerprint does not wrap, so do it here
export function wrapLine( text, width = 38 ) {

	const out = [];
	let cur = '';
	for ( const word of text.split( ' ' ) ) {

		if ( cur.length > 0 && cur.length + 1 + word.length > width ) {

			out.push( cur );
			cur = word;

		} else {

			cur = cur.length > 0 ? cur + ' ' + word : word;

		}

	}

	if ( cur.length > 0 )
		out.push( cur );
	return out.join( '\n' );

}

export function displayName( classname ) {

	const names = {
		monster_army: 'Grunt', monster_dog: 'Rottweiler', monster_ogre: 'Ogre',
		monster_knight: 'Knight', monster_hell_knight: 'Death Knight',
		monster_zombie: 'Zombie', monster_wizard: 'Scrag', monster_demon1: 'Fiend',
		monster_shambler: 'Shambler', monster_enforcer: 'Enforcer',
		monster_fish: 'Rotfish', monster_shalrath: 'Vore', monster_tarbaby: 'Spawn',
		monster_boss: 'Chthon', monster_oldone: 'Shub-Niggurath',
	};
	return names[ classname ] || classname.replace( /^monster_/, '' );

}

//============================================================================
// Engine glue
//============================================================================

function classnameOf( ent ) {

	return PR_GetString( ent.v.classname );

}

function historyFor( key ) {

	if ( historyMap !== sv.name ) {

		histories.clear();
		historyMap = sv.name;

	}

	let h = histories.get( key );
	if ( ! h ) {

		h = [];
		histories.set( key, h );

	}

	return h;

}

function sendToClient( client, svc, text ) {

	if ( ! client || ! client.active || ! client.message )
		return;
	MSG_WriteByte( client.message, svc );
	MSG_WriteString( client.message, text );

}

// Make the monster hostile to the player through the progs' own AI entry
// point (th_run), the same thing FoundTarget does in ai.qc.
function makeHostile( ent, player ) {

	const playerProg = EDICT_TO_PROG( player );
	if ( ent.v.enemy === playerProg )
		return;

	const thRun = GetEdictFieldValue( ent, 'th_run' );
	if ( ! thRun )
		return;
	const fn = thRun.accessor.getInt32( thRun.ofs );
	if ( ! fn )
		return;

	ent.v.enemy = playerProg;
	ent.v.goalentity = playerProg;

	const oldSelf = pr_global_struct.self;
	const oldOther = pr_global_struct.other;
	pr_global_struct.time = sv.time;
	pr_global_struct.self = EDICT_TO_PROG( ent );
	pr_global_struct.other = playerProg;
	PR_ExecuteProgram( fn );
	pr_global_struct.self = oldSelf;
	pr_global_struct.other = oldOther;

}

async function askBrain( payload ) {

	const res = await fetch( npc_brain_url.string, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( payload ),
	} );
	const text = await res.text();
	if ( ! res.ok )
		throw new Error( `brain ${res.status}: ${text.slice( 0, 120 )}` );
	try {

		return JSON.parse( text );

	} catch {

		throw new Error( `brain returned non-JSON (${res.status}): ${text.slice( 0, 120 )}` );

	}

}

// Server side: one conversation turn with a monster, triggered by the
// player talking or by the monster spotting the player. Everything the reply
// touches is re-validated first, because the world keeps running while the
// request is in flight.
function converse( { client, player, ent, classname, distance, event, said } ) {

	const map = sv.name;
	const key = `${sessionId}:${map}:${ent.index}:${classname}`;
	const history = historyFor( key );
	const payload = {
		character: classname,
		event,
		playerSaid: said,
		conversationId: key,
		history: history.slice( - HISTORY_TURNS ),
		context: {
			map,
			distance,
			monsterHealth: Math.round( ent.v.health ),
			playerHealth: Math.round( player.v.health ),
			hostileToPlayer: ent.v.enemy === EDICT_TO_PROG( player ),
		},
	};

	return askBrain( payload ).then( ( raw ) => {

		const reply = sanitizeReply( raw );
		const stillThere = sv.name === map && ! ent.free && ent.v.health > 0
			&& classnameOf( ent ) === classname;
		if ( ! reply || ! stillThere )
			return;

		if ( event === 'talk' )
			history.push( { speaker: 'player', text: said } );
		history.push( { speaker: 'npc', text: reply.line } );
		if ( history.length > HISTORY_TURNS * 2 )
			history.splice( 0, history.length - HISTORY_TURNS * 2 );

		const name = displayName( classname );
		if ( event === 'talk' )
			sendToClient( client, svc_centerprint, wrapLine( `${name}: ${reply.line}` ) );
		sendToClient( client, svc_print, `${name}: ${reply.line}\n` );

		if ( reply.audioId ) {

			// louder when close; the client plays it from the brain's /audio
			const vol = Math.max( 0.35, Math.min( 1, 1 - distance / 1600 ) ).toFixed( 2 );
			sendToClient( client, svc_stufftext, `npc_speak ${reply.audioId} ${vol}\n` );

		}

		if ( reply.action === 'attack' && ! player.free && player.v.health > 0 )
			makeHostile( ent, player );

	} );

}

function Talk_f() {

	if ( cmd_source === src_command ) {

		Cmd_ForwardToServer();
		return;

	}

	const client = host_client;
	const player = sv_player;
	if ( ! player || player.v.health <= 0 )
		return;

	const said = ( Cmd_Args() || '' ).replace( /^"|"$/g, '' ).trim().slice( 0, MAX_SAY_LENGTH );
	if ( said.length === 0 ) {

		sendToClient( client, svc_print, 'usage: talk <what you say>\n' );
		return;

	}

	if ( pending.has( client ) ) {

		sendToClient( client, svc_print, '(still waiting for a reply)\n' );
		return;

	}

	const target = pickTalkTarget( sv.edicts, sv.num_edicts, player, classnameOf );
	if ( ! target ) {

		sendToClient( client, svc_print, 'Nobody is close enough to hear you.\n' );
		return;

	}

	pending.add( client );
	sendToClient( client, svc_print, `You say to the ${displayName( target.classname )}: "${said}"\n` );

	converse( { client, player, ent: target.ent, classname: target.classname,
		distance: target.distance, event: 'talk', said } ).catch( ( err ) => {

		Con_Printf( '%s', `npc brain unavailable: ${err.message}\n` );
		sendToClient( client, svc_print, 'It does not seem to understand you.\n' );

	} ).finally( () => {

		pending.delete( client );

	} );

}

//============================================================================
// Sight barks: a monster that has just locked onto a player shouts at them.
// Rate-limited per monster and globally, because every bark is a model call
// and a TTS call.
//============================================================================

export const npc_barks = new cvar_t( 'npc_barks', '1' );
export const BARK_GLOBAL_COOLDOWN = 6; // seconds of server time between barks
export const BARK_MONSTER_COOLDOWN = 30;
export const BARK_RANGE = 1400;
// cannot speak, so a bark would only be a stage direction; not worth a call
const MUTE = new Set( [ 'monster_dog', 'monster_fish', 'monster_tarbaby' ] );

const lastEnemy = new Map(); // `${map}:${index}` -> enemy prog seen last scan
const lastBark = new Map(); // `${map}:${index}` -> sv.time of last bark
let lastBarkAny = - Infinity;
let barkInFlight = false;

export function shouldBark( { now, prevEnemy, enemy, clientProg, lastForMonster, lastAny, distance, mute } ) {

	if ( mute || enemy === 0 || enemy === prevEnemy || enemy !== clientProg )
		return false;
	if ( distance > BARK_RANGE )
		return false;
	if ( now - lastAny < BARK_GLOBAL_COOLDOWN || now - ( lastForMonster ?? - Infinity ) < BARK_MONSTER_COOLDOWN )
		return false;
	return true;

}

function scanForBarks() {

	if ( ! sv.active || ! sv.edicts || npc_barks.value === 0 )
		return;
	if ( historyMap !== sv.name ) {

		lastEnemy.clear();
		lastBark.clear();
		lastBarkAny = - Infinity;

	}

	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const ent = sv.edicts[ i ];
		if ( ! ent || ent.free || ! ( ( ent.v.flags | 0 ) & FL_MONSTER ) || ent.v.health <= 0 )
			continue;

		const slot = `${sv.name}:${i}`;
		const enemy = ent.v.enemy | 0;
		const prevEnemy = lastEnemy.get( slot ) ?? 0;
		lastEnemy.set( slot, enemy );
		if ( barkInFlight || enemy === prevEnemy || enemy === 0 )
			continue;

		// only players are worth barking at; find which client it is
		const clientIndex = svs.clients.findIndex( ( c ) => c && c.active && c.edict && EDICT_TO_PROG( c.edict ) === enemy );
		if ( clientIndex < 0 )
			continue;
		const client = svs.clients[ clientIndex ];
		const player = client.edict;
		const o = ent.v.origin, p = player.v.origin;
		const distance = Math.round( Math.hypot( o[ 0 ] - p[ 0 ], o[ 1 ] - p[ 1 ], o[ 2 ] - p[ 2 ] ) );
		const classname = classnameOf( ent );

		if ( ! shouldBark( { now: sv.time, prevEnemy, enemy, clientProg: enemy, lastForMonster: lastBark.get( slot ),
			lastAny: lastBarkAny, distance, mute: MUTE.has( classname ) } ) )
			continue;

		lastBark.set( slot, sv.time );
		lastBarkAny = sv.time;
		barkInFlight = true;
		historyFor( '' ); // keep historyMap in step with the map
		converse( { client, player, ent, classname, distance, event: 'sight', said: '' } )
			.catch( ( err ) => Con_Printf( '%s', `npc bark failed: ${err.message}\n` ) )
			.finally( () => {

				barkInFlight = false;

			} );

	}

}

//============================================================================
// Client side: play a line the server told us about.
//============================================================================

let currentVoice = null;

function Speak_f() {

	const id = Cmd_Argv( 1 );
	const vol = Math.max( 0, Math.min( 1, parseFloat( Cmd_Argv( 2 ) ) || 1 ) );
	if ( ! /^[a-f0-9]{32}$/.test( id ) || typeof Audio === 'undefined' )
		return;

	let base;
	try {

		base = new URL( npc_brain_url.string ).origin;

	} catch {

		return;

	}

	if ( currentVoice )
		currentVoice.pause();
	currentVoice = new Audio( `${base}/audio/${id}` );
	// follow the game's own volume slider (Quake's default is 0.7)
	const master = Cvar_VariableValue( 'volume' );
	currentVoice.volume = vol * Math.max( 0, Math.min( 1, master / 0.7 ) );
	currentVoice.play().catch( ( err ) => Con_Printf( '%s', `npc voice: ${err.message}\n` ) );

}

export function NPC_Init() {

	Cvar_RegisterVariable( npc_brain_url );
	Cvar_RegisterVariable( npc_barks );
	Cmd_AddCommand( 'talk', Talk_f );
	Cmd_AddCommand( 'npc_speak', Speak_f );
	sessionId = Math.random().toString( 36 ).slice( 2, 10 );
	if ( ! barkTimer )
		barkTimer = setInterval( () => {

			try {

				scanForBarks();

			} catch ( err ) {

				Con_Printf( '%s', `npc bark scan: ${err.message}\n` );

			}

		}, 250 );

}

let sessionId = 'local';
let barkTimer = null;
