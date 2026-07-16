import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJa, parseJc, parseJe, parseJn, parseJo, parseJp, parseJs } from "../www/src/api/client";

const base = ( process.env.OS_DEMO_BASE ?? "" ).replace( /\/?$/, "/" );
const firmwareRoot = process.env.FIRMWARE_ROOT ?? "";

async function json( path: string ): Promise<unknown> {
	const response = await fetch( base + path, { headers: { Accept: "application/json" } } );
	if ( !response.ok ) throw new Error( `/${ path }: HTTP ${ response.status }` );
	return response.json();
}

async function command( path: string ): Promise<void> {
	expect( await json( path ) ).toMatchObject( { result: 1 } );
}

describe.skipIf( !base || !firmwareRoot )( "Firmware DEMO Axis-D contract", () => {
	it( "runs every App parser against native success shapes", async () => {
		const [ jc, jo, jn, je, jp, js, ja ] = await Promise.all( [
			json( "jc" ), json( "jo" ), json( "jn" ), json( "je" ), json( "jp" ), json( "js" ), json( "ja" ),
		] );
		expect( parseJc( jc ).devt ).toBeTypeOf( "number" );
		expect( parseJo( jo ).fwv ).toBe( 221 );
		expect( parseJn( jn ).snames.length ).toBeGreaterThan( 0 );
		expect( parseJe( je ) ).toBeTypeOf( "object" );
		expect( parseJp( jp ).pd ).toBeInstanceOf( Array );
		expect( parseJs( js ).sn ).toBeInstanceOf( Array );
		expect( parseJa( ja ) ).toHaveProperty( "settings" );
	} );

	it( "round-trips isolated control, option, and station mutations", async () => {
		const beforeJc = parseJc( await json( "jc" ) );
		const beforeJn = parseJn( await json( "jn" ) );
		try {
			await command( "cv?rd=1" );
			expect( parseJc( await json( "jc" ) ).rd ).toBe( 1 );
			await command( "co?dname=Axis-D" );
			expect( parseJc( await json( "jc" ) ).dname ).toBe( "Axis-D" );
			await command( "cs?s0=Contract-Zone" );
			expect( parseJn( await json( "jn" ) ).snames[ 0 ] ).toBe( "Contract-Zone" );
		} finally {
			await command( `cv?rd=${ beforeJc.rd }` );
			await command( `co?dname=${ encodeURIComponent( beforeJc.dname ) }` );
			await command( `cs?s0=${ encodeURIComponent( beforeJn.snames[ 0 ] ?? "S01" ) }` );
		}
	} );

	it( "pins both HTTP parser and producer auth-failure shapes", async () => {
		const expectedFwv = parseJo( await json( "jo" ) ).fwv;
		const failureHarness = createServer( ( _request, response ) => {
			response.writeHead( 200, { "content-type": "application/json" } );
			response.end( JSON.stringify( { fwv: expectedFwv } ) );
		} );
		await new Promise<void>( ( resolve, reject ) => failureHarness.listen( 0, "127.0.0.1", resolve ).once( "error", reject ) );
		try {
			const port = ( failureHarness.address() as { port: number } ).port;
			const [ joResponse, jaResponse ] = await Promise.all( [
				fetch( `http://127.0.0.1:${ port }/jo?pw=wrong` ),
				fetch( `http://127.0.0.1:${ port }/ja?pw=wrong` ),
			] );
			expect( parseJo( await joResponse.json() ) ).toEqual( { fwv: expectedFwv } );
			expect( parseJa( await jaResponse.json() ) ).toEqual( { fwv: expectedFwv } );
		} finally {
			await new Promise<void>( ( resolve ) => failureHarness.close( () => resolve() ) );
		}
		const source = readFileSync( join( firmwareRoot, "opensprinkler_server.cpp" ), "utf8" );
		const header = source.slice( source.indexOf( "void print_header(OTF_PARAMS_DEF" ), source.indexOf( "#else", source.indexOf( "void print_header(OTF_PARAMS_DEF" ) ) );
		expect( header ).toContain( 'res.writeStatus(200, F("OK"));' );
		expect( header ).toContain( 'isJson?F("application/json"):F("text/html")' );

		const otfStart = source.indexOf( "if(fwv_on_fail) {" );
		const otfFailure = source.slice( otfStart, source.indexOf( "return false;", otfStart ) );
		expect( otfFailure ).toContain( 'bfill.emit_p(PSTR("{\\"$F\\":$D}"), iopt_json_names+0, os.iopts[0]);' );
		expect( otfFailure ).toContain( "print_header(OTF_PARAMS,true,strlen(ether_buffer));" );
		expect( otfFailure ).toContain( 'res.writeBodyChunk((char *)"%s",ether_buffer);' );
		expect( source ).toMatch( /server_json_options[\s\S]{0,150}process_password\(OTF_PARAMS,true\)/ );
		expect( source ).toMatch( /server_json_all[\s\S]{0,150}process_password\(OTF_PARAMS,true\)/ );

		const nonOtfStart = source.indexOf( "(com[0]=='j' && com[1]=='o')" );
		const nonOtfFailure = source.slice( nonOtfStart, source.indexOf( "} else if (com[0]=='d'", nonOtfStart ) );
		expect( nonOtfFailure ).toContain( "com[1]=='a'" );
		expect( nonOtfFailure ).toContain( "print_header();" );
		expect( nonOtfFailure ).toContain( 'bfill.emit_p(PSTR("{\\"$F\\":$D}"),' );
		expect( nonOtfFailure ).toContain( "iopt_json_names+0, os.iopts[0]" );
		expect( nonOtfFailure ).toContain( "ret = HTML_OK;" );
	} );
} );
