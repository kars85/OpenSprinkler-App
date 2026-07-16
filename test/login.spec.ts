// @vitest-environment jsdom
/**
 * Login UI flow test (jsdom) — the password form drives the version-gated auth and resolves
 * with the validated pwHash, re-prompting on a wrong password.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runLogin, renderLoginForm } from "../www/src/auth/login";
import { md5 } from "../www/src/auth/md5";

afterEach( () => vi.restoreAllMocks() );

function mockJo( authenticated: boolean ): typeof fetch {
	return vi.fn( async () => ( {
		ok: true, status: 200, statusText: "OK",
		json: async () => authenticated ? { fwv: 221, wl: 100 } : { fwv: 221 },
	} ) as Response ) as unknown as typeof fetch;
}

function submit( mount: HTMLElement, pw: string ): void {
	( mount.querySelector( "#os_pw" ) as HTMLInputElement ).value = pw;
	( mount.querySelector( "form" ) as HTMLFormElement ).dispatchEvent( new Event( "submit", { cancelable: true, bubbles: true } ) );
}

describe( "renderLoginForm", () => {
	it( "renders a password field and surfaces an error", () => {
		expect( renderLoginForm() ).toContain( 'type="password"' );
		expect( renderLoginForm( "Invalid password" ) ).toContain( "Invalid password" );
	} );
} );

describe( "runLogin", () => {
	it( "resolves with md5(pw) when the device accepts it (fwv>=213)", async () => {
		globalThis.fetch = mockJo( true );
		const mount = document.createElement( "div" );
		const p = runLogin( mount, "http://d/" );
		submit( mount, "secret" );
		await expect( p ).resolves.toBe( md5( "secret" ) );
	} );

	it( "re-prompts with an error on a wrong password", async () => {
		globalThis.fetch = mockJo( false );
		const mount = document.createElement( "div" );
		void runLogin( mount, "http://d/" );
		submit( mount, "wrong" );
		await new Promise( ( r ) => setTimeout( r, 0 ) ); // let the async handler re-render
		expect( mount.innerHTML ).toContain( "Invalid password" );
		expect( mount.querySelector( "#os_pw" ) ).not.toBeNull(); // form still present
	} );
} );
