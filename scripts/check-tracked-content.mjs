#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isDocumentation = ( path ) => path.endsWith( ".md" ) || /(^|\/)\.env(?:\.|$)/.test( path );
// Google Maps browser keys are intentionally public and already shipped by the frozen legacy UI.
// Keep the exception path-specific; new keys anywhere else fail the scan.
const legacyPublicGoogleKey = new Set( [ "www/js/map.js", "www/js/modules/options.js" ] );
const rules = [
	{
		name: "private IPv4 address in tracked documentation",
		when: isDocumentation,
		pattern: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
	},
	{ name: "OTC token", pattern: /\bOT(?!0{30}\b)[0-9a-fA-F]{30}\b/g },
	{ name: "GitHub token", pattern: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g },
	{ name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "Google API key", when: ( path ) => !legacyPublicGoogleKey.has( path ), pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
	{
		name: "literal credential environment assignment",
		pattern: /^\s*(?:(?:export\s+)|(?:\$env:))?(?:CONTROLLER_PW|OS_(?:LIVE_)?(?:PW|PWHASH)|[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD))\s*=\s*(?!["']?(?:<|\$)|$)[^\s#]+/gm,
	},
	{
		name: "literal password command argument",
		pattern: /(?:--pw|--pwhash)(?:=|\s+)["']?(?!<|\$|%3C)[^<\s`"']+/g,
	},
	{
		name: "literal password query in tracked documentation",
		when: isDocumentation,
		pattern: /[?&]pw=(?!<|md5\(|\$\{|%3C)[^&\s`"']+/g,
	},
];

export function scanText( path, text ) {
	const findings = [];
	for ( const rule of rules ) {
		if ( rule.when && !rule.when( path ) ) continue;
		for ( const match of text.matchAll( rule.pattern ) ) {
			findings.push( { path, line: text.slice( 0, match.index ).split( "\n" ).length, rule: rule.name } );
		}
	}
	return findings;
}

export function scanTrackedFiles( cwd = process.cwd() ) {
	const paths = execFileSync( "git", [ "ls-files", "-z" ], { cwd } ).toString( "utf8" ).split( "\0" ).filter( Boolean );
	return paths.flatMap( ( path ) => {
		const contents = readFileSync( resolve( cwd, path ) );
		return contents.includes( 0 ) ? [] : scanText( path.replaceAll( "\\", "/" ), contents.toString( "utf8" ) );
	} );
}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( resolve( process.argv[ 1 ] ) ).href ) {
	const findings = scanTrackedFiles();
	if ( findings.length ) {
		for ( const finding of findings ) console.error( `${ finding.path }:${ finding.line }: ${ finding.rule }` );
		process.exitCode = 1;
	} else {
		console.log( "tracked-content scan passed" );
	}
}
