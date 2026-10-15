import { makePlan } from '../tools/arena-plan.mjs';

function assert( c, m ) { if ( ! c ) throw new Error( m ); }
const ARMS = [ 'arm:clef-flash', 'arm:decider-4b', 'arm:d3-edge', 'so1', 'off' ];
const PERS = [ 'vindictive', 'greedy', 'showoff', 'cautious', 'bully' ];
const plan = makePlan( ARMS, PERS );

Deno.test( 'every arm plays every slot equally often, and every match uses each arm exactly once', () => {

	const count = {};
	for ( let m = 0; m < 25; m ++ ) {

		const { modes } = plan( m );
		assert( [ ...modes ].sort().join() === [ ...ARMS ].sort().join(), 'match ' + m + ' is not a permutation' );
		modes.forEach( ( a, slot ) => { count[ a + '@' + slot ] = ( count[ a + '@' + slot ] || 0 ) + 1; } );

	}
	assert( Object.keys( count ).length === 25 && Object.values( count ).every( ( v ) => v === 5 ), JSON.stringify( count ) );

} );

Deno.test( 'every (slot, persona) pair appears exactly once per N*P matches, so persona is not confounded with slot', () => {

	const seen = new Map();
	for ( let m = 0; m < 25; m ++ ) {

		const { modes, persona } = plan( m );
		modes.forEach( ( a, slot ) => { const k = a + '|' + slot + '|' + persona; seen.set( k, ( seen.get( k ) || 0 ) + 1 ); } );

	}
	assert( seen.size === 125 && [ ...seen.values() ].every( ( v ) => v === 1 ), 'size ' + seen.size );

} );

Deno.test( 'each arm is followed equally often, in each persona block, and the followed slot is consistent', () => {

	const byArm = {};
	for ( let m = 0; m < 25; m ++ ) {

		const p = plan( m );
		byArm[ p.followArm ] = ( byArm[ p.followArm ] || 0 ) + 1;
		assert( p.modes[ p.followSlot ] === p.followArm, 'followSlot does not point at followArm' );

	}
	assert( Object.values( byArm ).every( ( v ) => v === 5 ) && Object.keys( byArm ).length === 5, JSON.stringify( byArm ) );
	for ( let q = 0; q < 5; q ++ ) {

		const arms = new Set( Array.from( { length: 5 }, ( _, s ) => plan( q * 5 + s ).followArm ) );
		assert( arms.size === 5, 'persona block ' + q + ' does not follow every arm' );

	}

} );

Deno.test( 'the plan is deterministic and works for other sizes', () => {

	assert( JSON.stringify( plan( 37 ) ) === JSON.stringify( makePlan( ARMS, PERS )( 37 ) ), 'deterministic' );
	const p3 = makePlan( [ 'a', 'b', 'c' ], [ 'x', 'y' ] );
	for ( let m = 0; m < 12; m ++ ) assert( new Set( p3( m ).modes ).size === 3, 'perm ' + m );

} );
