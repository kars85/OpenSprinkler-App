/**
 * Settings mapper tests — the pure build*() functions that turn read form values into device
 * command params (the testable contract between the Settings forms and the typed commands).
 */
import { describe, it, expect } from "vitest";
import { buildGeneralOptions, offsetHoursToTz, tzToOffsetHours } from "../www/src/views/settings/general";
import { buildWeatherOptions } from "../www/src/views/settings/weather";
import { buildNetworkOptions } from "../www/src/views/settings/network";
import { buildStationConfig } from "../www/src/views/settings/stations-edit";
import { buildProgramInput, parseClock } from "../www/src/views/settings/program-edit";
import { encodeProgram, encodeDate } from "../www/src/api/encode";
import { decodeProgram } from "../www/src/api/decode";

describe( "general options", () => {
	it( "maps form values to named /co params (tz from GMT offset; dname on fw>=2191)", () => {
		expect( buildGeneralOptions( {
			dname: "Yard", tzOffset: "-8", wl: "120", sdt: "10", lg: true, sn1t: "1", sn1o: false,
		}, 2214 ) ).toEqual( { dname: "Yard", tz: offsetHoursToTz( -8 ), wl: 120, sdt: 10, lg: 1, sn1t: 1, sn1o: 0 } );
	} );
	it( "tz helpers round-trip (UTC and a fractional offset)", () => {
		expect( offsetHoursToTz( 0 ) ).toBe( 48 );
		expect( tzToOffsetHours( 48 ) ).toBe( 0 );
		expect( offsetHoursToTz( 5.5 ) ).toBe( 70 );        // GMT+5:30
		expect( tzToOffsetHours( 70 ) ).toBe( 5.5 );
	} );
	it( "omits a blank device name", () => {
		expect( buildGeneralOptions( { dname: "", tzOffset: "0", wl: "100", sdt: "0", lg: false, sn1t: "0", sn1o: false }, 2214 ) )
			.not.toHaveProperty( "dname" );
	} );
	it( "omits the device name on firmware older than 2191", () => {
		expect( buildGeneralOptions( { dname: "Yard", tzOffset: "0", wl: "100", sdt: "0", lg: false, sn1t: "0", sn1o: false }, 2190 ) )
			.not.toHaveProperty( "dname" );
	} );
	it( "rejects device names the firmware would rewrite", () => {
		expect( () => buildGeneralOptions( {
			dname: "Back\\Yard", tzOffset: "0", wl: "100", sdt: "0", lg: false, sn1t: "0", sn1o: false,
		}, 2214 ) ).toThrow( /backslashes/ );
	} );
	it( "validates the signed, quantized station-delay contract", () => {
		const base = { dname: "Yard", tzOffset: "0", wl: "100", lg: false, sn1t: "0", sn1o: false };
		expect( buildGeneralOptions( { ...base, sdt: "-15" }, 2214 ).sdt ).toBe( -15 );
		expect( () => buildGeneralOptions( { ...base, sdt: "7" }, 2214 ) ).toThrow( /5-second/ );
		expect( () => buildGeneralOptions( { ...base, sdt: "-605" }, 2214 ) ).toThrow( /-600/ );
	} );
} );

describe( "weather options", () => {
	it( "stores the method in uwt and the restriction in wto.cali", () => {
		const out = buildWeatherOptions(
			{ method: "1", restriction: true, loc: "37,-122", provider: "OWM", key: "abc" },
			{ scales: [ 100, 100 ] },
		);
		expect( out.uwt ).toBe( 1 );
		expect( out.loc ).toBe( "37,-122" );
		expect( out.wto ).toContain( '"scales":[100,100]' ); // preserved
		expect( out.wto ).toContain( '"provider":"OWM"' );
		expect( out.wto ).toContain( '"key":"abc"' );
		expect( out.wto ).toContain( '"cali":1' );
	} );
	it( "preserves spaces in location and omits a blank location", () => {
		expect( buildWeatherOptions( { method: "0", loc: "New York, NY" }, {} ).loc ).toBe( "New York, NY" );
		expect( buildWeatherOptions( { method: "0", loc: "" }, {} ) ).not.toHaveProperty( "loc" );
	} );
	it( "does not overwrite a stored key when the submitted key is blank", () => {
		const out = buildWeatherOptions( { method: "3", key: "" }, { key: "stored" } );
		expect( out.wto ).toContain( '"key":"stored"' );
	} );
	it( "clears a stored key only when explicitly requested", () => {
		const out = buildWeatherOptions( { method: "3", key: "", clearKey: true }, { key: "stored", provider: "OWM" } );
		expect( out.wto ).not.toContain( "stored" );
		expect( out.wto ).toContain( '"key":""' );
		expect( out.wto ).toContain( '"provider":"OWM"' );
	} );
	it( "emits a non-empty firmware payload when the key is the only stored weather option", () => {
		expect( buildWeatherOptions( { method: "0", key: "", clearKey: true }, { key: "stored" } ).wto )
			.toBe( '"key":""' );
	} );
	it( "rejects firmware-rewritten location characters and oversized weather options", () => {
		expect( () => buildWeatherOptions( { method: "0", loc: 'Bad "place"' }, {} ) ).toThrow( /Quotes/ );
		expect( () => buildWeatherOptions( { method: "0" }, { key: "é".repeat( 160 ) } ) ).toThrow( /320 UTF-8 bytes/ );
		expect( () => buildWeatherOptions( { method: "not-a-method" }, {} ) ).toThrow( /whole number/ );
	} );
} );

describe( "network options", () => {
	it( "splits the HTTP port and the static address octets when DHCP is off", () => {
		const out = buildNetworkOptions( {
			dhcp: false, ip: "192.168.1.50", gw: "192.168.1.1", dns: "8.8.8.8", subnet: "255.255.255.0",
			port: "8080", ntp: true, ntpServer: "129.6.15.28",
		} );
		expect( out ).toMatchObject( {
			dhcp: 0, ntp: 1, hp0: 8080 & 0xff, hp1: ( 8080 >> 8 ) & 0xff,
			ip1: 192, ip2: 168, ip3: 1, ip4: 50, gw1: 192, gw4: 1, dns1: 8, subn1: 255, subn4: 0,
			ntp1: 129, ntp4: 28,
		} );
	} );
	it( "omits static octets when DHCP is on", () => {
		const out = buildNetworkOptions( { dhcp: true, ip: "192.168.1.50", port: "80", ntp: false } );
		expect( out ).not.toHaveProperty( "ip1" );
		expect( out.dhcp ).toBe( 1 );
	} );
	it( "rejects malformed addresses and ports instead of coercing them", () => {
		expect( () => buildNetworkOptions( {
			dhcp: false, ip: "192.168.1.999", gw: "192.168.1.1", subnet: "255.255.255.0", port: "80", ntp: false,
		} ) ).toThrow( /octet/i );
		expect( () => buildNetworkOptions( { dhcp: true, port: "70000", ntp: false } ) ).toThrow( /65535/ );
	} );
} );

describe( "station config", () => {
	it( "builds per-board attribute bytes + names + groups (fw220+)", () => {
		const cfg = buildStationConfig( {
			name_0: "Front", name_1: "Back",
			dis_0: false, dis_1: true, rain_0: true, rain_1: false, grp_0: "0", grp_1: "255",
		}, 2, 221 );
		expect( cfg.names ).toEqual( { 0: "Front", 1: "Back" } );
		expect( cfg.disabled ).toEqual( [ 2 ] );    // station 1 disabled -> bit1
		expect( cfg.ignoreRain ).toEqual( [ 1 ] );  // station 0 ignores rain -> bit0
		expect( cfg.groups ).toEqual( { 0: 0, 1: 255 } );
		expect( cfg.fwv ).toBe( 221 );
	} );
	it( "omits groups on firmware < 220", () => {
		const cfg = buildStationConfig( { name_0: "A", dis_0: false, rain_0: false }, 1, 219 );
		expect( cfg.groups ).toBeUndefined();
	} );
	it( "preserves station-name spaces and rejects values firmware would ignore or rewrite", () => {
		expect( buildStationConfig( {
			name_0: "Front Lawn", dis_0: false, rain_0: false, grp_0: "0",
		}, 1, 221 ).names ).toEqual( { 0: "Front Lawn" } );
		expect( () => buildStationConfig( {
			name_0: "", dis_0: false, rain_0: false, grp_0: "0",
		}, 1, 221 ) ).toThrow( /station name/ );
		expect( () => buildStationConfig( {
			name_0: 'Front "Lawn"', dis_0: false, rain_0: false, grp_0: "0",
		}, 1, 221 ) ).toThrow( /Quotes/ );
	} );
} );

describe( "program editor mapper", () => {
	it( "parseClock accepts valid HH:MM and rejects invalid clocks", () => {
		expect( parseClock( "06:30" ) ).toBe( 390 );
		expect( parseClock( "24:00" ) ).toBeNull();
		expect( parseClock( "12:60" ) ).toBeNull();
		expect( parseClock( "nope" ) ).toBeNull();
	} );
	it( "builds a ProgramInput that survives encode→decode", () => {
		const input = buildProgramInput( {
			name: "Morning", enabled: true, useWeather: true, restriction: "odd",
			schedType: "weekly", wd_0: true, wd_2: true, wd_4: true,
			startType: "fixed", t_0: "06:00", t_1: "", t_2: "", t_3: "",
			dur_0: "10", dur_1: "0",
		}, 2 );
		expect( input.durations ).toEqual( [ 600, 0 ] );
		expect( input.restriction ).toBe( "odd" );
		const enc = encodeProgram( input );
		const d = decodeProgram(
			[ enc.v[ 0 ], enc.v[ 1 ], enc.v[ 2 ], enc.v[ 3 ], enc.v[ 4 ], enc.name, [ 0, 0, 0 ] ],
			[ "Front", "Back" ],
		);
		expect( d.type ).toBe( "weekly" );
		expect( d.days ).toContain( "Mon, Wed, Fri" );
		expect( d.startTimes ).toContain( "06:00" );
		expect( d.name ).toBe( "Morning" );
	} );
	it( "populates the date range when useDateRange + drFrom/drTo are set", () => {
		const input = buildProgramInput( {
			name: "Seasonal", enabled: true, useWeather: false, restriction: "none",
			schedType: "weekly", wd_0: true, startType: "fixed", t_0: "06:00",
			useDateRange: true, drFrom: "2024-05-01", drTo: "2024-09-30", dur_0: "10",
		}, 1 );
		expect( input.dateRange ).toEqual( { enable: true, from: encodeDate( 5, 1 ), to: encodeDate( 9, 30 ) } );
	} );
	it( "rejects invalid schedule times, dates, and durations", () => {
		const base = {
			name: "Bad", enabled: false, useWeather: false, restriction: "none", schedType: "weekly", wd_0: true,
			startType: "fixed", t_0: "24:00", dur_0: "10",
		};
		expect( () => buildProgramInput( base, 1 ) ).toThrow( /24-hour time/ );
		expect( () => buildProgramInput( { ...base, t_0: "06:00", dur_0: "nope" }, 1 ) ).toThrow( /number/ );
		expect( () => buildProgramInput( {
			...base, schedType: "singlerun", singleDate: "2026-02-30", t_0: "06:00",
		}, 1 ) ).toThrow( /valid date/ );
	} );
	it( "rejects interval wrap, duplicate starts, fractional seconds, and epoch overflow", () => {
		const base = {
			name: "Guarded", enabled: false, useWeather: false, restriction: "none",
			startType: "fixed", t_0: "06:00", dur_0: "10",
		};
		expect( () => buildProgramInput( {
			...base, schedType: "interval", intervalDays: "4", startingInDays: "4",
		}, 1 ) ).toThrow( /less than the interval/ );
		expect( () => buildProgramInput( {
			...base, schedType: "weekly", wd_0: true, t_1: "06:00",
		}, 1 ) ).toThrow( /unique/ );
		expect( () => buildProgramInput( {
			...base, schedType: "weekly", wd_0: true, dur_0: "0.001",
		}, 1 ) ).toThrow( /whole seconds/ );
		expect( () => buildProgramInput( {
			...base, schedType: "singlerun", singleDate: "2149-12-31",
		}, 1 ) ).toThrow( /supported range/ );
		expect( () => buildProgramInput( {
			...base, name: "x".repeat( 32 ), schedType: "weekly", wd_0: true,
		}, 1 ) ).toThrow( /32 UTF-8 bytes/ );
		expect( () => buildProgramInput( {
			...base, name: " ", schedType: "weekly", wd_0: true,
		}, 1 ) ).toThrow( /program name/ );
		expect( () => buildProgramInput( {
			...base, name: "Front\\Yard", schedType: "weekly", wd_0: true,
		}, 1 ) ).toThrow( /backslashes/ );
	} );
} );
