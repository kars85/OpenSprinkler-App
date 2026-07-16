/**
 * View-render tests — stations + programs views render the decoded fixture data.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseJc, parseJn, parseJo, parseJp } from "../www/src/api/client";
import { renderStations } from "../www/src/views/stations-view";
import { renderPrograms } from "../www/src/views/programs-view";
import { renderWeatherConfig } from "../www/src/views/settings/weather";

function fx( name: string ): unknown {
	return JSON.parse( readFileSync( fileURLToPath( new URL( `./fixtures/api/${ name }.fixture.json`, import.meta.url ) ), "utf8" ) );
}
const jc = parseJc( fx( "jc" ) );
const jn = parseJn( fx( "jn" ) );
const jp = parseJp( fx( "jp" ) );
const jo = parseJo( fx( "jo" ) );

describe( "renderStations", () => {
	const html = renderStations( jc, jn );
	it( "lists all stations with names and the active count", () => {
		expect( html ).toContain( "Front Lawn" );
		expect( html ).toContain( "Back Lawn" );
		expect( html ).toContain( "(8, 1 on)" );  // 8 stations, sbits => 1 on
	} );
	it( "marks the running station On with time remaining", () => {
		expect( html ).toContain( ">On<" );
		expect( html ).toContain( "left" );        // 600s remaining
	} );
	it( "joins the /jn special bit to the /je type without exposing raw definition data", () => {
		const specialJn = { ...jn, stn_spe: [ 1 ] };
		const rendered = renderStations( jc, specialJn, { 0: { st: 6, sd: "PRIVATE_TOKEN" } } );
		expect( rendered ).toContain( "OTC remote" );
		expect( rendered ).not.toContain( "PRIVATE_TOKEN" );
	} );
} );

describe( "renderPrograms", () => {
	const html = renderPrograms( jp, jn );
	it( "renders the decoded program schedule", () => {
		expect( html ).toContain( "Morning Watering" );
		expect( html ).toContain( "Mon, Wed, Fri" );
		expect( html ).toContain( "06:30" );
		expect( html ).toContain( "Sunrise +30m" );
		expect( html ).toContain( "05-01" );        // date range
		expect( html ).toContain( "Sunrise to Sunset" ); // solar duration
	} );
	it( "shows only participating stations (duration > 0)", () => {
		expect( html ).toContain( "3 stations" );
	} );
} );

describe( "renderWeatherConfig", () => {
	it( "never renders a stored API key into the document", () => {
		const html = renderWeatherConfig( jo, { ...jc, wto: { key: "PRIVATE_KEY", cali: 1 } } );
		expect( html ).toContain( 'type="password"' );
		expect( html ).toContain( "Stored — blank keeps it" );
		expect( html ).toContain( "Clear stored API key" );
		expect( html ).not.toContain( "PRIVATE_KEY" );
		expect( html ).toContain( 'name="restriction" checked' );
	} );
} );
