/**
 * Auth tests — MD5 correctness (RFC 1321 vectors: must match the firmware's md5(password),
 * so getting this wrong would lock users out) + the seam's version-gated authenticate() flow.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { md5 } from "../www/src/auth/md5";
import { BrowserDeviceSeam } from "../www/src/seam/device";

describe( "md5 (RFC 1321 test vectors)", () => {
	it( "matches the standard vectors", () => {
		expect( md5( "" ) ).toBe( "d41d8cd98f00b204e9800998ecf8427e" );
		expect( md5( "a" ) ).toBe( "0cc175b9c0f1b6a831c399e269772661" );
		expect( md5( "abc" ) ).toBe( "900150983cd24fb0d6963f7d28e17f72" );
		expect( md5( "message digest" ) ).toBe( "f96b697d7cb7938d525a2f31aaf161d0" );
		expect( md5( "abcdefghijklmnopqrstuvwxyz" ) ).toBe( "c3fcd3d76192e4007dfb496cca67e13b" );
		expect( md5( "The quick brown fox jumps over the lazy dog" ) ).toBe( "9e107d9d372bb6826bd81d3542a419d6" );
	} );
	it( "hashes UTF-8 correctly", () => {
		expect( md5( "café" ) ).toBe( md5( "café" ) );
		expect( md5( "café" ) ).toHaveLength( 32 );
	} );
} );

describe( "seam.authenticate (modern hash-only policy)", () => {
	afterEach( () => vi.restoreAllMocks() );

	function mockJo( authenticated: boolean ): typeof fetch {
		return vi.fn( async () => ( {
			ok: true, status: 200, statusText: "OK",
			json: async () => authenticated ? { fwv: 221, wl: 100 } : { fwv: 221 },
		} ) as Response ) as unknown as typeof fetch;
	}

	it( "sends only md5(pw) to /jo and returns the hash on success", async () => {
		const f = mockJo( true ); globalThis.fetch = f;
		const seam = new BrowserDeviceSeam( { baseUrl: "http://d/" } );
		const r = await seam.authenticate( "secret", md5 );
		expect( r.ok ).toBe( true );
		expect( r.pwHash ).toBe( md5( "secret" ) );
		const url = String( ( f as unknown as { mock: { calls: unknown[][] } } ).mock.calls[ 0 ][ 0 ] );
		expect( url ).toBe( "http://d/jo?pw=" + md5( "secret" ) );
		expect( url ).not.toContain( "secret" );
	} );

	it( "treats the firmware's fwv-only response as auth failure", async () => {
		const f = mockJo( false );
		globalThis.fetch = f;
		const seam = new BrowserDeviceSeam( { baseUrl: "http://d/" } );
		const r = await seam.authenticate( "wrong", md5 );
		expect( r.ok ).toBe( false );
		expect( r.pwHash ).toBe( md5( "wrong" ) );
		const calls = ( f as unknown as { mock: { calls: unknown[][] } } ).mock.calls;
		expect( calls ).toHaveLength( 1 );
		const url = String( calls[ 0 ]![ 0 ] );
		expect( url ).toBe( "http://d/jo?pw=" + md5( "wrong" ) );
		expect( url ).not.toMatch( /wrong|npw|cpw|\/sp/ );
	} );
} );
