#!/usr/bin/env node
/**
 * Read-only live contract capture. Credentials come from OS_PW/OS_PWHASH and sanitized
 * responses are written separately from the curated API fixtures.
 *
 *   OS_BASE=http://controller.local/ OS_PW=<password> npm run capture
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const isObject = ( value ) => value !== null && typeof value === "object" && !Array.isArray( value );
const blankLike = ( value ) => Array.isArray( value ) ? value.map( blankLike ) :
	isObject( value ) ? Object.fromEntries( Object.entries( value ).map( ( [ key, item ] ) => [ key, blankLike( item ) ] ) ) :
	typeof value === "string" ? "" : typeof value === "number" ? 0 : typeof value === "boolean" ? false : value;

function scrubSecrets( value ) {
	if ( Array.isArray( value ) ) return value.map( scrubSecrets );
	if ( !isObject( value ) ) return value;
	return Object.fromEntries( Object.entries( value ).map( ( [ key, item ] ) => [
		key,
		/(?:key|token|pass|secret|credential)/i.test( key ) ? blankLike( item ) : scrubSecrets( item ),
	] ) );
}

function sanitizeJc( raw ) {
	const data = scrubSecrets( structuredClone( raw ) );
	for ( const key of [ "loc", "mac", "dname", "ifkey", "jsp", "wsp" ] ) {
		if ( key in data ) data[ key ] = "";
	}
	if ( "eip" in data ) data.eip = typeof data.eip === "string" ? "" : 0;
	for ( const key of [ "wto", "mqtt", "email", "otc", "wtdata" ] ) {
		if ( key in data ) data[ key ] = blankLike( data[ key ] );
	}
	return data;
}

function sanitizeJo( raw ) {
	const data = scrubSecrets( structuredClone( raw ) );
	for ( const key of Object.keys( data ) ) {
		if ( /^(?:ip|gw|dns|ntp)[1-4]$/.test( key ) ) data[ key ] = 0;
	}
	if ( "devid" in data ) data.devid = 0;
	return data;
}

function sanitizeJn( raw ) {
	const data = scrubSecrets( structuredClone( raw ) );
	if ( Array.isArray( data.snames ) ) data.snames = data.snames.map( ( _, index ) => `Zone ${ index + 1 }` );
	return data;
}

function sanitizeJp( raw ) {
	const data = scrubSecrets( structuredClone( raw ) );
	if ( Array.isArray( data.pd ) ) {
		data.pd.forEach( ( program, index ) => {
			if ( Array.isArray( program ) && typeof program[ 5 ] === "string" ) program[ 5 ] = `Program ${ index + 1 }`;
		} );
	}
	return data;
}

function sanitizeJe( raw ) {
	const data = scrubSecrets( structuredClone( raw ) );
	for ( const station of Object.values( data ) ) {
		if ( isObject( station ) && "sd" in station ) station.sd = "";
	}
	return data;
}

export function sanitizeFixture( endpoint, raw ) {
	switch ( endpoint ) {
		case "jc": return sanitizeJc( raw );
		case "jo": return sanitizeJo( raw );
		case "jn": return sanitizeJn( raw );
		case "jp": return sanitizeJp( raw );
		case "je": return sanitizeJe( raw );
		case "ja": {
			const data = scrubSecrets( structuredClone( raw ) );
			if ( data.settings ) data.settings = sanitizeJc( data.settings );
			if ( data.options ) data.options = sanitizeJo( data.options );
			if ( data.stations ) data.stations = sanitizeJn( data.stations );
			if ( data.programs ) data.programs = sanitizeJp( data.programs );
			return data;
		}
		default: return scrubSecrets( structuredClone( raw ) );
	}
}

async function main() {
	const base = ( process.env.OS_LIVE_BASE || process.env.OS_BASE || "" ).replace( /\/?$/, "/" );
	let pwhash = process.env.OS_LIVE_PWHASH || process.env.OS_PWHASH;
	const password = process.env.OS_LIVE_PW ?? process.env.OS_PW;
	if ( !base ) throw new Error( "OS_BASE is required (for example, http://controller.local/)" );

	async function getJson( path ) {
		const separator = path.includes( "?" ) ? "&" : "?";
		const url = base + path + ( pwhash ? `${ separator }pw=${ encodeURIComponent( pwhash ) }` : "" );
		const response = await fetch( url, { headers: { Accept: "application/json" } } );
		if ( !response.ok ) throw new Error( `/${ path }: HTTP ${ response.status } ${ response.statusText }` );
		return response.json();
	}

	const probe = await getJson( "jo" );
	const preAuthFwv = typeof probe.fwv === "number" ? probe.fwv : 0;
	if ( preAuthFwv < 221 ) throw new Error( "controller is below the supported fwv 221 floor" );
	if ( !pwhash && password !== undefined ) pwhash = createHash( "md5" ).update( password ).digest( "hex" );

	const options = await getJson( "jo" );
	if ( !isObject( options ) || typeof options.fwv !== "number" || Object.keys( options ).length <= 2 ) {
		throw new Error( "/jo authentication failed or returned a pre-auth stub" );
	}
	const combinedVersion = options.fwv * 10 + ( typeof options.fwm === "number" ? options.fwm : 0 );
	if ( options.fwv !== 221 || combinedVersion < 2214 || typeof options.fwf !== "string" || !options.fwf.startsWith( "kars85." ) ) {
		throw new Error( "controller does not satisfy the authenticated 2214 + kars85 floor" );
	}
	const outDir = join( dirname( fileURLToPath( import.meta.url ) ), "..", "test", "fixtures", "live", String( combinedVersion ) );
	const now = Math.floor( Date.now() / 1000 );
	const endpoints = [
		[ "jc", "jc" ], [ "jo", "jo" ], [ "jn", "jn" ], [ "je", "je" ],
		[ "jp", "jp" ], [ "jl", `jl?start=${ now - 7 * 86400 }&end=${ now + 86340 }` ],
		[ "js", "js" ], [ "ja", "ja" ],
	];
	const validJc = ( data ) => isObject( data ) && typeof data.devt === "number" && Array.isArray( data.ps ) && Array.isArray( data.sbits );
	const validJo = ( data ) => isObject( data ) && typeof data.fwv === "number" && Object.keys( data ).length > 2;
	const validJn = ( data ) => isObject( data ) && Array.isArray( data.snames ) && Array.isArray( data.stn_dis );
	const validJe = ( data ) => isObject( data ) && Object.entries( data ).every( ( [ sid, station ] ) =>
		/^\d+$/.test( sid ) && isObject( station ) && typeof station.st === "number" && typeof station.sd === "string" );
	const validJp = ( data ) => isObject( data ) && typeof data.nprogs === "number" && Array.isArray( data.pd );
	const validJs = ( data ) => isObject( data ) && typeof data.nstations === "number" && Array.isArray( data.sn );
	const looksValid = {
		jc: validJc,
		jo: validJo,
		jn: validJn,
		je: validJe,
		jp: validJp,
		jl: Array.isArray,
		js: validJs,
		ja: ( data ) => isObject( data ) && validJc( data.settings ) && validJp( data.programs ) &&
			validJo( data.options ) && validJs( data.status ) && validJn( data.stations ),
	};

	await mkdir( outDir, { recursive: true } );
	let captured = 0;
	for ( const [ endpoint, path ] of endpoints ) {
		try {
			const data = endpoint === "jo" ? options : await getJson( path );
			if ( !looksValid[ endpoint ]( data ) ) throw new Error( "response failed its shape check" );
			await writeFile( join( outDir, `${ endpoint }.fixture.json` ), JSON.stringify( sanitizeFixture( endpoint, data ) ) + "\n" );
			console.log( `captured /${ endpoint }` );
			captured++;
		} catch ( error ) {
			console.error( `skipped /${ endpoint }: ${ error.message }` );
		}
	}
	if ( captured !== endpoints.length ) throw new Error( `captured ${ captured }/${ endpoints.length } endpoints` );
	console.log( `captured ${ captured}/${ endpoints.length} sanitized endpoints for ${ combinedVersion }` );
}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( resolve( process.argv[ 1 ] ) ).href ) {
	main().catch( ( error ) => {
		console.error( error.message );
		process.exitCode = 1;
	} );
}
