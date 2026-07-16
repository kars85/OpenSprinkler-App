/**
 * Local demo harness for the Phase-1 dashboard — Status / Stations / Programs / Weather / Log /
 * Diagnostics / Settings — rendered from MOCKED fixtures (no device). Runs the real seam → typed
 * client → decoders/encoders → views → host controller. Control + settings actions hit the mock,
 * which returns a success result so the flow is exercisable end-to-end.
 *
 *   npm run demo
 */
import jc from "../test/fixtures/api/jc.fixture.json";
import jo from "../test/fixtures/api/jo.fixture.json";
import jn from "../test/fixtures/api/jn.fixture.json";
import jp from "../test/fixtures/api/jp.fixture.json";
import jl from "../test/fixtures/api/jl.fixture.json";

import { BrowserDeviceSeam } from "../www/src/seam/device";
import { OsApiClient } from "../www/src/api/client";
import { mountDashboard } from "../www/src/views/host";
import type { DashboardData } from "../www/src/views/dashboard";
import { stationStatusBits } from "../www/src/api/decode";

// Firmware globals normally injected by server_home before home.js loads.
( globalThis as Record<string, unknown> ).ver = 221;
( globalThis as Record<string, unknown> ).ipas = 1;

// Mock transport: serve the fixtures for reads; return result:1 for change commands.
globalThis.fetch = ( async ( input: RequestInfo | URL ) => {
	const url = String( input );
	const isCommand = /\/(cm|cv|cr|co|cs|cp|dp)\b/.test( url ) || /\/(cm|cv|cr|co|cs|cp|dp)\?/.test( url );
	const body =
		isCommand ? { result: 1 } :
		url.includes( "/jc" ) ? jc :
		url.includes( "/jo" ) ? jo :
		url.includes( "/jn" ) ? jn :
		url.includes( "/je" ) ? {} :
		url.includes( "/jp" ) ? jp :
		url.includes( "/jl" ) ? jl :
		url.includes( "/js" ) ? { sn: jc.sbits.flatMap( ( bits ) => Array.from( { length: 8 }, ( _, bit ) => ( bits >> bit ) & 1 ) ), nstations: jn.snames.length } :
		null;
	await new Promise( ( r ) => setTimeout( r, 30 ) );
	return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
} ) as typeof fetch;

const mount = document.getElementById( "app" ) as HTMLElement;
const toastEl = document.getElementById( "toast" ) as HTMLElement | null;

let baseUrl = "http://demo-device/";

async function load(): Promise<DashboardData> {
	const api = new OsApiClient( new BrowserDeviceSeam( { baseUrl, ipas: 1, ver: 221 } ) );
	const [ c, o, n, e, p, l ] = await Promise.all( [
		api.getControllerStatus(), api.getOptions(), api.getStations(), api.getSpecialStations(), api.getPrograms(), api.getLogs(),
	] );
	// Showcase the fork build tag (#3): the kars85 firmware fork emits `fwf` in /jo.
	return { jc: c, jo: { ...o, fwf: "kars85.3" }, jn: n, je: e, jp: p, jl: l };
}

async function loadRuntime( current: DashboardData, cheap: boolean ): Promise<DashboardData> {
	const api = new OsApiClient( new BrowserDeviceSeam( { baseUrl, ipas: 1, ver: 221 } ) );
	if ( cheap ) {
		const js = await api.getStatus();
		return { ...current, jc: { ...current.jc, sbits: stationStatusBits( js.sn ) } };
	}
	return { ...current, jc: await api.getControllerStatus() };
}

function toast( message: string, isError = false ): void {
	if ( !toastEl ) return;
	toastEl.textContent = message;
	toastEl.className = isError ? "toast err" : "toast";
	// Errors are assertive so failures are announced promptly; success stays polite.
	toastEl.setAttribute( "role", isError ? "alert" : "status" );
	toastEl.setAttribute( "aria-live", isError ? "assertive" : "polite" );
	window.setTimeout( () => { if ( toastEl.textContent === message ) toastEl.textContent = ""; }, 4000 );
}

const api = new OsApiClient( new BrowserDeviceSeam( { baseUrl, ipas: 1, ver: 221 } ) );
const controller = mountDashboard( {
	mount, api, actions: true, load, loadRuntime, toast,
	ctx: { prompt: ( m, d ) => window.prompt( m, d ), confirm: ( m ) => window.confirm( m ) },
} );

document.querySelectorAll<HTMLInputElement>( 'input[name="path"]' ).forEach( ( el ) =>
	el.addEventListener( "change", () => {
		baseUrl = el.value === "otc" ? "https://cloud.openthings.io/forward/v1/DEMOTOKEN/" : "http://demo-device/";
		void controller.refresh();
	} )
);
