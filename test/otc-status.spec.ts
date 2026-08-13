/**
 * Status page OTC row — plain-language state via the shared otcStatus mapping, never the raw
 * numeric code ("status 0" was firmware vocabulary leaking into default copy).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseJc, parseJo, deriveCapabilities } from "../www/src/api/client";
import { renderControllerStatus } from "../www/src/spike/status-view";

function fx( name: string ): unknown {
	return JSON.parse( readFileSync( fileURLToPath( new URL( `./fixtures/api/${ name }.fixture.json`, import.meta.url ) ), "utf8" ) );
}
const jc = parseJc( fx( "jc" ) );
const jo = parseJo( fx( "jo" ) );

function statusHtml( otcs: number | undefined ): string {
	const jcVariant = { ...jc, ...( otcs === undefined ? {} : { otcs } ) };
	if ( otcs === undefined ) delete ( jcVariant as { otcs?: number } ).otcs;
	const caps = deriveCapabilities( jcVariant, jo );
	return renderControllerStatus( jcVariant, jo, { ...caps, otfCloud: true } );
}

describe( "status view Cloud (OTC) row", () => {
	it( "maps each code to plain language, never the raw number", () => {
		expect( statusHtml( 0 ) ).toContain( "Not Enabled" );
		expect( statusHtml( 1 ) ).toContain( "Connecting" );
		expect( statusHtml( 2 ) ).toContain( "Disconnected" );
		expect( statusHtml( 3 ) ).toContain( "Connected" );
		for ( const code of [ 0, 1, 2, 3 ] ) {
			expect( statusHtml( code ) ).not.toContain( `status ${ code }` );
		}
	} );
	it( "says 'Not reported' when the firmware omits otcs", () => {
		expect( statusHtml( undefined ) ).toContain( "Not reported" );
	} );
} );
