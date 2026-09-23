// pr_ext.js -- the handful of post-1996 QuakeC builtins most modern NetQuake
// engines provide and most mods (Frogbot, among others) assume.
//
//   #80 infokey  #81 stof  #82 multicast  #99 checkextension
//   #118 strzone  #119 strunzone
//
// Only what is implemented here is advertised by checkextension, so a mod
// that tests before it uses an extension takes its fallback path for
// everything else.

import { Con_DPrintf, SZ_Alloc, SZ_Clear, SZ_Write, sizebuf_t } from './common.js';
import { Cvar_FindVar } from './cvar.js';
import {
	OFS_RETURN, OFS_PARM0, OFS_PARM1,
} from './pr_comp.js';
import {
	G_FLOAT_SET, G_INT_SET, G_STRING, G_EDICTNUM,
	PR_SetTempString, pr_strings_data, PR_SetStringsData,
	sv,
} from './progs.js';
import { svs } from './server.js';

// Advertised extensions. Keep this to what this file really implements.
const EXTENSIONS = new Set( [ 'ZQ_QC_STRINGS' ] );

// MSG_MULTICAST (4) writes land here until multicast() flushes them.
export const MSG_MULTICAST = 4;
const multicastBuf = new sizebuf_t();

export function MulticastBuffer() {

	if ( ! multicastBuf.data ) SZ_Alloc( multicastBuf, 8192 );
	return multicastBuf;

}

/*
string(entity e, string key) infokey = #80

world: serverinfo/localinfo, which NetQuake engines expose as cvars.
client: the few userinfo keys a NetQuake server actually knows.
*/
function PF_infokey() {

	const entnum = G_EDICTNUM( OFS_PARM0 );
	const key = G_STRING( OFS_PARM1 );
	let value = '';

	if ( entnum === 0 ) {

		const v = Cvar_FindVar( key );
		if ( v ) value = v.string;

	} else if ( entnum <= ( svs.maxclients || 1 ) ) {

		const client = svs.clients[ entnum - 1 ];
		if ( client && client.active && key === 'name' ) value = client.name || '';

	}

	G_INT_SET( OFS_RETURN, PR_SetTempString( value ) );

}

// float(string s) stof = #81
function PF_stof() {

	const f = parseFloat( G_STRING( OFS_PARM0 ) );
	G_FLOAT_SET( OFS_RETURN, Number.isFinite( f ) ? f : 0 );

}

/*
void(vector where, float set) multicast = #82

NetQuake has no PVS/PHS-filtered unreliable send per client, so this goes to
everyone as a broadcast datagram. Effects may reach players who could not
see them; nothing is lost.
*/
function PF_multicast() {

	const buf = MulticastBuffer();
	if ( buf.cursize > 0 && sv.datagram && sv.datagram.data ) {

		if ( sv.datagram.cursize + buf.cursize <= sv.datagram.maxsize )
			SZ_Write( sv.datagram, buf.data.subarray( 0, buf.cursize ), buf.cursize );
		else
			Con_DPrintf( 'multicast: datagram full, dropped %s bytes\n', String( buf.cursize ) );

	}

	SZ_Clear( buf );

}

// float(string s) checkextension = #99
function PF_checkextension() {

	G_FLOAT_SET( OFS_RETURN, EXTENSIONS.has( G_STRING( OFS_PARM0 ) ) ? 1 : 0 );

}

// string(string s) strzone = #118 -- a copy that outlives the temp buffer
function PF_strzone() {

	const encoded = new TextEncoder().encode( G_STRING( OFS_PARM0 ) + '\0' );
	const grown = new Uint8Array( pr_strings_data.length + encoded.length );
	grown.set( pr_strings_data );
	grown.set( encoded, pr_strings_data.length );
	const ofs = pr_strings_data.length;
	PR_SetStringsData( grown );
	G_INT_SET( OFS_RETURN, ofs );

}

// void(string s) strunzone = #119 -- strings are never freed; mods call this
// rarely (team names, next map), so the growth is bounded in practice.
function PF_strunzone() {}

export const EXTENSION_BUILTINS = {
	80: PF_infokey,
	81: PF_stof,
	82: PF_multicast,
	99: PF_checkextension,
	118: PF_strzone,
	119: PF_strunzone,
};

// exported for tests
export { PF_infokey, PF_stof, PF_checkextension, PF_strzone, EXTENSIONS };
