/**
 * Weather view tests — friendly Multi-Day Levels empty-state (upstream #289) and the descriptive
 * weather-source / PWS footer (upstream #291).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseJc, parseJo } from "../www/src/api/client";
import { deriveWeatherHealth, renderWeather } from "../www/src/views/weather-view";

function fx( name: string ): unknown {
	return JSON.parse( readFileSync( fileURLToPath( new URL( `./fixtures/api/${ name }.fixture.json`, import.meta.url ) ), "utf8" ) );
}
const jc = parseJc( fx( "jc" ) );
const jo = parseJo( fx( "jo" ) );

describe( "renderWeather — adjustment summary", () => {
	const html = renderWeather( jc, jo );
	it( "shows the adjustment method and watering level", () => {
		expect( html ).toContain( "Adjustment method" );
		expect( html ).toContain( "Manual" );      // uwt 0
		expect( html ).toContain( "Watering level" );
		expect( html ).toContain( "100%" );          // wl 100
	} );
} );

describe( "renderWeather — Multi-Day Levels (#289)", () => {
	it( "renders the levels when present", () => {
		const html = renderWeather( jc, jo ); // wls [100]
		expect( html ).toContain( "Multi-Day Levels" );
		expect( html ).toContain( "Day 1" );
		expect( html ).toContain( "100%" );
	} );
	it( "shows a friendly empty-state instead of '[]' when empty", () => {
		const html = renderWeather( { ...jc, wls: [] }, jo );
		expect( html ).toContain( "Multi-Day Levels" );
		expect( html ).toContain( "None" );
		expect( html ).toContain( "isn't sending multi-day levels" );
		expect( html ).not.toContain( "[]" );
	} );
} );

describe( "renderWeather — current weather data", () => {
	it( "empty-states when wtdata is empty", () => {
		const html = renderWeather( jc, jo );
		expect( html ).toContain( "No weather data yet" ); // fixture wtdata {}
		expect( html ).toContain( 'data-target="Weather"' );
	} );
	it( "renders known wtdata fields with labels", () => {
		const html = renderWeather( { ...jc, wtdata: { t: 18, h: 55, p: 2 } }, jo );
		expect( html ).toContain( "Mean temp" );
		expect( html ).toContain( "18" );
		expect( html ).toContain( "Mean humidity" );
		expect( html ).toContain( "55%" );
	} );
	it( "isolates a weather-service failure and retains the last-success timestamp", () => {
		const html = renderWeather( { ...jc, wterr: -3 }, jo );
		expect( html ).toContain( 'data-weather-health="last-update-failed"' );
		expect( html ).toContain( "Weather health: Last update failed" );
		expect( html ).toContain( "Timed Out" );
		expect( html ).toContain( "Last successful weather update" );
		expect( html ).toContain( "Non-weather controls remain available" );
	} );
	it( "reports the effective 0% hold while a weather restriction is active", () => {
		const html = renderWeather( { ...jc, wtrestr: 1 }, { ...jo, wl: 100 } );
		expect( html ).toContain( "weather-enabled schedules are held at 0%" );
		expect( html ).not.toContain( "controller effect remains 100%" );
	} );
} );

describe( "deriveWeatherHealth", () => {
	it( "uses the specified not-yet, pending, failure, stale, and current order", () => {
		expect( deriveWeatherHealth( { ...jc, lwc: 0, lswc: 0, wterr: -1 }, jo.tz ).health ).toBe( "not-yet-updated" );
		expect( deriveWeatherHealth( { ...jc, lwc: 0, lswc: jc.devt - 60, wterr: -1 }, jo.tz ).health ).toBe( "update-pending" );
		expect( deriveWeatherHealth( { ...jc, wterr: 5 }, jo.tz ).health ).toBe( "last-update-failed" );
		expect( deriveWeatherHealth( { ...jc, lwc: jc.devt, lswc: jc.devt - 86401, wterr: 0 }, jo.tz ).health ).toBe( "stale" );
		expect( deriveWeatherHealth( jc, jo.tz ).health ).toBe( "current" );
	} );
	it( "flags a controller clock earlier than its last success", () => {
		expect( deriveWeatherHealth( { ...jc, lwc: jc.devt, lswc: jc.devt + 60 }, jo.tz ).clockReview ).toBe( true );
		expect( renderWeather( { ...jc, lwc: jc.devt, lswc: jc.devt + 60 }, jo ) ).toContain( "Controller clock needs review" );
	} );
	it( "labels latched observations as last-successful after a failure", () => {
		const html = renderWeather( { ...jc, wterr: 1, wtdata: { t: 20, weatherProvider: "OWM" } }, jo );
		expect( html ).toContain( "Last successful Weather data" );
		expect( html ).toContain( "Last successful source: OpenWeather" );
		expect( html ).not.toContain( "Current Weather Data" );
	} );
} );

describe( "renderWeather — weather-source footer (#291)", () => {
	it( "spells out a local PWS source with the abbr-expansion explainer line", () => {
		const html = renderWeather( { ...jc, wtdata: { wp: "local" } }, jo );
		expect( html ).toContain( "your local Personal Weather Station (PWS)" );
		// the distinct, provider==='local'-gated explainer line (not just the source label substring):
		expect( html ).toContain( '<abbr title="Personal Weather Station">PWS</abbr>' );
		expect( html ).toContain( "is your own weather station" );
	} );
	it( "names a known cloud provider and omits the PWS explainer", () => {
		const html = renderWeather( { ...jc, wtdata: { weatherProvider: "OWM" } }, jo );
		expect( html ).toContain( "OpenWeather" );
		expect( html ).not.toContain( "is your own weather station" );
	} );
	it( "falls back to 'manual adjustment' when no provider and uwt is Manual", () => {
		const html = renderWeather( jc, jo ); // wtdata {}, uwt 0
		expect( html ).toContain( "manual adjustment (no weather service)" );
	} );
	it( "falls back to 'service at <host>' when no provider but a non-Manual method + host", () => {
		const html = renderWeather( { ...jc, wtdata: {} }, { ...jo, uwt: 1 } ); // Zimmerman, host present
		expect( html ).toContain( "service at weather.opensprinkler.com" );
	} );
	it( "shows 'not reported' when no provider, non-Manual method, and no host", () => {
		const html = renderWeather( { ...jc, wtdata: {}, wsp: "" }, { ...jo, uwt: 1 } );
		expect( html ).toContain( "Weather source: not reported" );
	} );
	it( "shows the configured service host", () => {
		expect( renderWeather( jc, jo ) ).toContain( "weather.opensprinkler.com" ); // jc.wsp
	} );
} );
