import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFixture } from "../scripts/capture-fixtures.mjs";

test( "live captures preserve shapes and remove controller identity", () => {
	const raw = {
		settings: { devt: 1, loc: "1,2", mac: "aa", dname: "Home", eip: 123, jsp: "https://private", wsp: "http://private", wto: { apiKey: "secret", scale: 42 }, mqtt: { host: "private", password: "secret" }, wtdata: { station: "private", value: 4 } },
		options: { fwv: 221, fwm: 4, ip1: 10, ip2: 0, ip3: 0, ip4: 2, devid: 99 },
		stations: { snames: [ "Front", "Back" ], stn_dis: [ 0 ] },
		programs: { pd: [ [ 1, 0, 0, [], [], "Morning", [ 0, 0, 0 ] ] ] },
	};
	const clean = sanitizeFixture( "ja", raw );
	assert.equal( clean.settings.loc, "" );
	assert.equal( clean.settings.wto.apiKey, "" );
	assert.equal( clean.settings.wto.scale, 0 );
	assert.equal( clean.options.ip1, 0 );
	assert.deepEqual( clean.stations.snames, [ "Zone 1", "Zone 2" ] );
	assert.equal( clean.programs.pd[ 0 ][ 5 ], "Program 1" );
	assert.equal( raw.settings.dname, "Home", "sanitizer must not mutate the response" );
} );

test( "special-station definitions and nested credentials are blanked", () => {
	assert.deepEqual( sanitizeFixture( "je", { 0: { st: 2, sd: "private-definition" } } ), { 0: { st: 2, sd: "" } } );
	assert.deepEqual( sanitizeFixture( "jc", { token: "secret", eip: "private", ps: [] } ), { token: "", eip: "", ps: [] } );
} );
