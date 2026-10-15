import { resolveDecision, weaponName, distance, canUse } from '../src/bot_mind.js';

function assert( cond, msg ) {

	if ( ! cond ) throw new Error( msg );

}

const ents = {
	p2: { free: false, v: { health: 100 }, classname: 'player', model: 'progs/player.mdl' },
	p131: { free: false, v: { health: 80 }, classname: 'frogbot', model: '/' },
	i71: { free: false, v: { health: 0 }, classname: 'weapon_nailgun', model: 'progs/g_nail.mdl' },
	i72: { free: false, v: { health: 0 }, classname: 'item_armor1', model: '' }, // already picked up
};
const lookup = ( id ) => ents[ id ] ?? null;
const offered = {
	opponents: new Map( [ [ 'p2', 'player' ], [ 'p131', 'frogbot' ] ] ),
	items: new Map( [ [ 'i71', 'weapon_nailgun' ], [ 'i72', 'item_armor1' ] ] ),
};

Deno.test( 'resolveDecision applies a valid focus and goal', () => {

	const r = resolveDecision( { focusId: 'p131', goalId: 'i71' }, offered, lookup );
	assert( r.enemy === ents.p131 && r.goal === ents.i71, JSON.stringify( r ) );

} );

Deno.test( 'resolveDecision drops ids that were not offered, dead targets, taken items and reused edicts', () => {

	assert( resolveDecision( { focusId: 'p9', goalId: 'i9' }, offered, lookup ).enemy === null, 'unoffered id' );
	assert( resolveDecision( { goalId: 'i72' }, offered, lookup ).goal === null, 'item already taken (empty model)' );
	const dead = { ...ents, p2: { ...ents.p2, v: { health: 0 } } };
	assert( resolveDecision( { focusId: 'p2' }, offered, ( id ) => dead[ id ] ).enemy === null, 'dead opponent' );
	const reused = { ...ents, i71: { ...ents.i71, classname: 'item_shells' } };
	assert( resolveDecision( { goalId: 'i71' }, offered, ( id ) => reused[ id ] ).goal === null, 'edict reused by another entity' );
	assert( resolveDecision( null, offered, lookup ).enemy === null, 'null decision' );
	assert( resolveDecision( { focusId: 'none', goalId: 'none' }, offered, lookup ).goal === null, 'explicit none' );

} );

Deno.test( 'weaponName and distance', () => {

	assert( weaponName( 32 ) === 'rocket launcher', 'rl' );
	assert( weaponName( 999 ) === 'unknown', 'unknown' );
	assert( distance( [ 0, 0, 0 ], [ 3, 4, 0 ] ) === 5, 'distance' );

} );

Deno.test( 'canUse: only items the bot can actually pick up are offered', () => {

	const full = { health: 100, items: 1 | 32, armorvalue: 150 };
	assert( ! canUse( 'item_health', 0, full ), 'health box at full health' );
	assert( canUse( 'item_health', 2, full ), 'megahealth still wanted at 100' );
	assert( ! canUse( 'item_health', 2, { ...full, health: 250 } ), 'megahealth at 250' );
	assert( ! canUse( 'weapon_rocketlauncher', 0, full ), 'owned weapon' );
	assert( canUse( 'weapon_lightning', 0, full ), 'missing weapon' );
	assert( ! canUse( 'item_armor2', 0, full ), 'yellow armour at 150' );
	assert( canUse( 'item_armorInv', 0, full ), 'red armour at 150' );
	assert( canUse( 'item_artifact_super_damage', 0, full ), 'quad' );

} );

import { personaKeyFor, modeForSlot, attributeKills, pickupCategory } from '../src/bot_mind.js';
import { personaFor } from '../npc-brain/bots.ts';

Deno.test( 'engine and brain assign the SAME personality to a name (the benchmark groups by it)', () => {

	for ( const n of [ 'Reptile', 'goldenboy', 'yoda', 'Thresh', 'Dude', 'girlie', 'x', '' ] )
		assert( personaKeyFor( n ) === personaFor( n ).key, `${n}: ${personaKeyFor( n )} vs ${personaFor( n ).key}` );

} );

Deno.test( 'modeForSlot reads the cvar by join order and defaults to jev', () => {

	assert( modeForSlot( 'jev,off,random', 1 ) === 'off', 'slot 1' );
	assert( modeForSlot( 'jev, off ,random', 2 ) === 'random', 'trims' );
	assert( modeForSlot( 'jev,off', 5 ) === 'jev', 'past the list' );
	assert( modeForSlot( 'cheat', 0 ) === 'jev', 'unknown mode' );
	assert( modeForSlot( '', 0 ) === 'jev', 'empty' );

} );

Deno.test( 'attributeKills only credits an unambiguous kill', () => {

	assert( JSON.stringify( attributeKills( [ 2 ], [ 3 ] ) ) === '[{"victim":2,"killer":3}]', 'one death, one frag' );
	assert( attributeKills( [ 2, 4 ], [ 3 ] ).length === 0, 'two deaths' );
	assert( attributeKills( [ 2 ], [ 3, 4 ] ).length === 0, 'two gainers' );
	assert( attributeKills( [ 2 ], [ 2 ] ).length === 0, 'self' );
	assert( attributeKills( [ 2 ], [] ).length === 0, 'suicide / world' );

} );

Deno.test( 'pickupCategory', () => {

	assert( pickupCategory( 'item_armor2', 0 ) === 'armor', 'armor' );
	assert( pickupCategory( 'item_health', 2 ) === 'megahealth', 'mega' );
	assert( pickupCategory( 'item_health', 0 ) === null, 'small health is not high-value' );
	assert( pickupCategory( 'weapon_rocketlauncher', 0 ) === 'weapon', 'weapon' );
	assert( pickupCategory( 'item_artifact_super_damage', 0 ) === 'powerup', 'quad' );
	assert( pickupCategory( 'item_shells', 0 ) === null, 'ammo' );

} );

import { quakeToAscii, shouldDecide, highValue } from '../src/bot_mind.js';

Deno.test( 'quakeToAscii: red letters, gold digits, brackets; control bytes dropped', () => {

	// the v1 benchmark logged this frogbot name as "GENERAL\x05fA\x13lURe"
	if ( quakeToAscii( 'GENERAL\x05fA\x13lURe' ) !== 'GENERALfA1lURe' ) throw new Error( quakeToAscii( 'GENERAL\x05fA\x13lURe' ) );
	if ( quakeToAscii( String.fromCharCode( 0xC1, 0xC2 ) ) !== 'AB' ) throw new Error( 'red charset' );
	if ( quakeToAscii( '\x10x\x11' ) !== '[x]' ) throw new Error( 'brackets' );

} );

Deno.test( 'the engine hashes the same cleaned name the brain receives', () => {

	const raw = 'GENERAL\x05fA\x13lURe';
	const sentToBrain = quakeToAscii( raw ).replace( /[^\x20-\x7e]/g, '' ); // bots.ts parseSituation
	if ( personaKeyFor( quakeToAscii( raw ) ) !== personaFor( sentToBrain ).key ) throw new Error( 'persona parity' );

} );

Deno.test( 'shouldDecide: events or staleness, never past the budget', () => {

	const base = { want: null, now: 10, next: 40, used: 0, budget: 20 };
	if ( shouldDecide( base ) ) throw new Error( 'no event, not stale: wait' );
	if ( ! shouldDecide( { ...base, want: 'spawn' } ) ) throw new Error( 'respawn decides' );
	if ( ! shouldDecide( { ...base, want: 'frag' } ) ) throw new Error( 'own frag decides' );
	if ( ! shouldDecide( { ...base, now: 40 } ) ) throw new Error( 'stale decides' );
	if ( shouldDecide( { ...base, want: 'spawn', used: 20 } ) ) throw new Error( 'budget is a hard cap' );

} );

Deno.test( 'highValue: only items worth steering a greedy bot to', () => {

	for ( const c of [ 'item_armor2', 'item_armorInv', 'weapon_rocketlauncher', 'weapon_lightning', 'item_artifact_super_damage' ] )
		if ( ! highValue( c, 0 ) ) throw new Error( c );
	if ( ! highValue( 'item_health', 2 ) ) throw new Error( 'megahealth' );
	for ( const c of [ 'item_armor1', 'weapon_nailgun', 'weapon_supershotgun', 'item_shells' ] )
		if ( highValue( c, 0 ) ) throw new Error( c );
	if ( highValue( 'item_health', 0 ) ) throw new Error( 'plain health box' );

} );

import { personaForSlot } from '../src/bot_mind.js';

Deno.test( 'personaForSlot: per-slot list, one key for all, else the name', () => {

	if ( personaForSlot( 'greedy,bully,cautious', 1, 'x' ) !== 'bully' ) throw new Error( 'per slot' );
	if ( personaForSlot( 'showoff', 2, 'x' ) !== 'showoff' ) throw new Error( 'one for all' );
	if ( personaForSlot( '', 0, 'Reptile' ) !== personaKeyFor( 'Reptile' ) ) throw new Error( 'name fallback' );
	if ( personaForSlot( 'nonsense', 0, 'Reptile' ) !== personaKeyFor( 'Reptile' ) ) throw new Error( 'unknown key' );

} );

Deno.test( 'modeForSlot accepts the open-weights so1 mind', () => {

	if ( modeForSlot( 'so1,jev,off', 0 ) !== 'so1' ) throw new Error( 'so1' );

} );

Deno.test( 'modeForSlot accepts named open-model arms and rejects look-alikes', () => {

	const s = 'arm:clef-flash,arm:decider-4b,off,so1,arm:d3.edge';
	const want = [ 'arm:clef-flash', 'arm:decider-4b', 'off', 'so1', 'arm:d3.edge' ];
	for ( let i = 0; i < want.length; i ++ ) if ( modeForSlot( s, i ) !== want[ i ] ) throw new Error( `slot ${i}: ${modeForSlot( s, i )}` );
	for ( const bad of [ 'arm:Clef', 'arm:', 'arm:a b', 'arm:../x', 'ARM:clef', 'arm:x;y' ] ) {

		if ( modeForSlot( bad, 0 ) !== 'jev' ) throw new Error( `${bad} must fall back to jev, got ${modeForSlot( bad, 0 )}` );

	}

} );

import { followPose, followTarget, FOLLOW_HUD_FIELDS } from '../src/bot_mind.js';

Deno.test( 'followPose puts the camera at the bot eyes and never copies a dead health onto the god-mode observer', () => {

	const p = followPose( { origin: [ 100, 200, 30 ], view_ofs: [ 0, 0, 22 ], v_angle: [ 10, 90, 5 ], angles: [ 0, 0, 0 ], health: - 4 } );
	if ( p.origin.join() !== '100,200,30' ) throw new Error( p.origin.join() );
	if ( p.angles.join() !== '10,90,0' ) throw new Error( 'angles ' + p.angles.join() + ' (roll must be 0)' );
	if ( p.health !== 1 ) throw new Error( 'health ' + p.health );
	// falls back to .angles when v_angle is all zero; default eye height 22 when view_ofs is unset
	const q = followPose( { origin: [ 0, 0, 0 ], view_ofs: [ 0, 0, 0 ], v_angle: [ 0, 0, 0 ], angles: [ 3, 45, 0 ], health: 80 } );
	if ( q.angles.join() !== '3,45,0' || q.health !== 80 ) throw new Error( 'fallback ' + JSON.stringify( q ) );
	// a crouched/odd view height shifts the camera relative to the 22-unit standing eye
	const r = followPose( { origin: [ 0, 0, 10 ], view_ofs: [ 0, 0, 12 ], v_angle: [ 1, 1, 0 ], angles: [ 0, 0, 0 ], health: 5 } );
	if ( r.origin[ 2 ] !== 0 ) throw new Error( 'view height ' + r.origin[ 2 ] );

} );

Deno.test( 'followTarget picks the bot by 1-based join order, ignores humans, 0 and free edicts', () => {

	const edicts = { 3: { free: false, id: 'A' }, 5: { free: false, id: 'B' }, 7: { free: true, id: 'C' }, 9: { free: false, id: 'H' } };
	const entries = [ [ 3, { isBot: true, slot: 0 } ], [ 5, { isBot: true, slot: 1 } ], [ 7, { isBot: true, slot: 2 } ], [ 9, { isBot: false, slot: undefined } ] ];
	if ( followTarget( 1, entries, edicts )?.id !== 'A' ) throw new Error( 'slot 1' );
	if ( followTarget( 2, entries, edicts )?.id !== 'B' ) throw new Error( 'slot 2' );
	for ( const bad of [ 0, - 1, 3, 4, 'x', NaN, undefined ] ) {

		if ( followTarget( bad, entries, edicts ) !== null ) throw new Error( 'must be null for ' + bad );

	}

} );

Deno.test( 'the HUD copy list never includes position, health control or ownership fields', () => {

	for ( const forbidden of [ 'origin', 'health', 'angles', 'v_angle', 'classname', 'movetype', 'solid', 'flags', 'owner' ] ) {

		if ( FOLLOW_HUD_FIELDS.includes( forbidden ) ) throw new Error( forbidden );

	}

} );
