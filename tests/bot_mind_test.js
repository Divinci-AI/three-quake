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
