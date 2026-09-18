import { pickTalkTarget, sanitizeReply, wrapLine, displayName, shouldBark, TALK_RANGE, BARK_RANGE } from '../src/npc_talk.js';
import { FL_MONSTER } from '../src/server.js';

function assert( cond, msg ) {

	if ( ! cond ) throw new Error( msg );

}

function ent( index, { origin = [ 0, 0, 0 ], flags = FL_MONSTER, health = 50, free = false, classname = 'monster_army' } = {} ) {

	return { index, free, classname, v: { origin, flags, health, v_angle: [ 0, 0, 0 ] } };

}

// player at the origin looking down +x (yaw 0)
const player = ent( 1, { flags: 0, health: 100, classname: 'player' } );
const cls = ( e ) => e.classname;

Deno.test( 'pickTalkTarget picks the nearest living monster in front', () => {

	const edicts = [ ent( 0 ), player,
		ent( 2, { origin: [ 400, 0, 0 ], classname: 'monster_ogre' } ),
		ent( 3, { origin: [ 200, 20, 0 ] } ),
	];
	const t = pickTalkTarget( edicts, edicts.length, player, cls );
	assert( t && t.ent.index === 3, `expected edict 3, got ${t && t.ent.index}` );
	assert( t.distance === 201, `distance ${t.distance}` );

} );

Deno.test( 'pickTalkTarget ignores monsters behind, dead, freed, out of range, or non-monsters', () => {

	const edicts = [ ent( 0 ), player,
		ent( 2, { origin: [ - 100, 0, 0 ] } ), // behind
		ent( 3, { origin: [ 100, 0, 0 ], health: 0 } ), // dead
		ent( 4, { origin: [ 100, 0, 0 ], free: true } ), // freed edict
		ent( 5, { origin: [ TALK_RANGE + 50, 0, 0 ] } ), // too far
		ent( 6, { origin: [ 100, 0, 0 ], flags: 0, classname: 'item_health' } ), // not a monster
		ent( 7, { origin: [ 0, 300, 0 ] } ), // 90 degrees off to the side
	];
	const t = pickTalkTarget( edicts, edicts.length, player, cls );
	assert( t === null, `expected no target, got edict ${t && t.ent.index}` );

} );

Deno.test( 'sanitizeReply only lets through a clean line and an allowlisted action', () => {

	assert( sanitizeReply( null ) === null, 'null' );
	assert( sanitizeReply( { line: '   ', action: 'attack' } ) === null, 'blank line' );

	const r = sanitizeReply( { line: 'Get out.\nNow! \u{1F52B}', action: 'teleport_player' } );
	assert( r.line === 'Get out. Now!', `line was ${JSON.stringify( r.line )}` );
	assert( r.action === 'none', `unknown action must degrade to none, got ${r.action}` );

	assert( sanitizeReply( { line: 'Die.', action: 'attack' } ).action === 'attack', 'attack allowed' );
	assert( sanitizeReply( { line: 'x'.repeat( 500 ) } ).line.length === 200, 'length capped' );

} );

Deno.test( 'wrapLine keeps every line within width', () => {

	const out = wrapLine( 'Grunt: I have orders and you are definitely not in them, marine.', 20 );
	for ( const l of out.split( '\n' ) )
		assert( l.length <= 20, `line too long: ${l}` );
	assert( out.replace( /\n/g, ' ' ) === 'Grunt: I have orders and you are definitely not in them, marine.', 'words lost' );

} );

Deno.test( 'displayName maps classnames and falls back for mod monsters', () => {

	assert( displayName( 'monster_army' ) === 'Grunt', 'grunt' );
	assert( displayName( 'monster_gremlin' ) === 'gremlin', 'fallback' );

} );

Deno.test( 'sanitizeReply only passes a strictly-hex audioId (it lands in a console command)', () => {

	const good = 'a'.repeat( 32 );
	assert( sanitizeReply( { line: 'Hi.', audioId: good } ).audioId === good, 'hex id kept' );
	assert( sanitizeReply( { line: 'Hi.', audioId: good + '\nquit' } ).audioId === null, 'injection dropped' );
	assert( sanitizeReply( { line: 'Hi.' } ).audioId === null, 'absent is null' );

} );

Deno.test( 'shouldBark fires once on a fresh lock-on and respects every limit', () => {

	const base = { now: 100, prevEnemy: 0, enemy: 1, clientProg: 1, lastForMonster: undefined, lastAny: - Infinity, distance: 300, mute: false };
	assert( shouldBark( base ), 'fresh lock-on barks' );
	assert( ! shouldBark( { ...base, prevEnemy: 1 } ), 'same enemy as last scan' );
	assert( ! shouldBark( { ...base, enemy: 0 } ), 'no enemy' );
	assert( ! shouldBark( { ...base, clientProg: 2 } ), 'enemy is not this player' );
	assert( ! shouldBark( { ...base, mute: true } ), 'mute monster' );
	assert( ! shouldBark( { ...base, distance: BARK_RANGE + 1 } ), 'too far' );
	assert( ! shouldBark( { ...base, lastAny: 97 } ), 'global cooldown' );
	assert( ! shouldBark( { ...base, lastForMonster: 90 } ), 'per-monster cooldown' );

} );
