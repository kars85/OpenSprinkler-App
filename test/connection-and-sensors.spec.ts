/**
 * Connection-tier banner behavior + physical sensor rows on the Status page.
 * A missed poll or two on a LAN device gets a quiet note; the red card waits for a sustained
 * outage and never leaks raw fetch exception text. An active rain sensor must be visible —
 * "Rain delay: Off" alone reads as "nothing is pausing watering", a lie while it rains.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseJc, parseJo, deriveCapabilities } from "../www/src/api/client";
import { connectionTier, publicConnectionDetail } from "../www/src/views/host";
import { renderControllerStatus } from "../www/src/spike/status-view";

function fx( name: string ): unknown {
	return JSON.parse( readFileSync( fileURLToPath( new URL( `./fixtures/api/${ name }.fixture.json`, import.meta.url ) ), "utf8" ) );
}
const jc = parseJc( fx( "jc" ) );
const jo = parseJo( fx( "jo" ) );

describe( "connectionTier", () => {
	it( "is fresh below 12s, waiting from 12s, unreachable from 45s", () => {
		expect( connectionTier( 11_000, 0 ) ).toBe( "fresh" );
		expect( connectionTier( 12_000, 0 ) ).toBe( "waiting" );
		expect( connectionTier( 44_999, 0 ) ).toBe( "waiting" );
		expect( connectionTier( 45_000, 0 ) ).toBe( "unreachable" );
	} );
	it( "is fresh before any successful response (boot shows its own loading state)", () => {
		expect( connectionTier( 99_999, null ) ).toBe( "fresh" );
	} );
} );

describe( "publicConnectionDetail", () => {
	it( "replaces raw fetch failures with plain scope", () => {
		expect( publicConnectionDetail( "TypeError: Failed to fetch" ) ).toBe( "The controller did not respond." );
		expect( publicConnectionDetail( "NetworkError when attempting to fetch resource." ) ).toBe( "The controller did not respond." );
	} );
	it( "passes through already-scoped messages and null", () => {
		expect( publicConnectionDetail( "Weather service unavailable" ) ).toBe( "Weather service unavailable" );
		expect( publicConnectionDetail( null ) ).toBe( null );
	} );
} );

describe( "status view sensor rows", () => {
	function html( sn1t: number, sn1: 0 | 1 ): string {
		const jcVariant = { ...jc, sn1 };
		const joVariant = { ...jo, sn1t };
		return renderControllerStatus( jcVariant, joVariant, deriveCapabilities( jcVariant, joVariant ) );
	}
	it( "shows an active rain sensor as pausing watering", () => {
		const out = html( 1, 1 );
		expect( out ).toContain( "Rain sensor" );
		expect( out ).toContain( "Rain detected — watering paused" );
	} );
	it( "shows a quiet rain sensor", () => {
		expect( html( 1, 0 ) ).toContain( "No rain detected" );
	} );
	it( "renders no rain-sensor row when none is configured (or it is a flow meter)", () => {
		expect( html( 0, 0 ) ).not.toContain( "Rain sensor" );
		expect( html( 2, 1 ) ).not.toContain( "Rain sensor" );
	} );
	it( "shows a soil sensor in soil words", () => {
		const out = html( 3, 1 );
		expect( out ).toContain( "Soil sensor" );
		expect( out ).toContain( "Soil is wet — watering paused" );
	} );
} );
