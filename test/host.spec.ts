// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, UnsupportedControllerError, type OsApiClient } from "../www/src/api/client";
import type { DashboardData } from "../www/src/views/dashboard";
import { mountDashboard, type DashboardController } from "../www/src/views/host";
import { encodeProgram, type ProgramInput } from "../www/src/api/encode";
import type { OSProgram } from "../www/src/api/types";

function fixture( name: string ): unknown {
	return JSON.parse( readFileSync( `test/fixtures/api/${ name }.fixture.json`, "utf8" ) );
}

const data = {
	jc: fixture( "jc" ), jo: fixture( "jo" ), jn: fixture( "jn" ),
	je: {}, jp: fixture( "jp" ), jl: fixture( "jl" ),
} as DashboardData;

function tuple( input: ProgramInput ): OSProgram {
	const encoded = encodeProgram( input );
	return [
		encoded.v[ 0 ] as number, encoded.v[ 1 ] as number, encoded.v[ 2 ] as number,
		encoded.v[ 3 ] as number[], encoded.v[ 4 ] as number[], encoded.name,
		encoded.dateRange ? [ encoded.dateRange.enable ? 1 : 0, encoded.dateRange.from, encoded.dateRange.to ] : [ 0, 0, 0 ],
	];
}

let hidden = false;
let online = true;
const controllers: DashboardController[] = [];

type MountedDashboard = DashboardController & { toast: ReturnType<typeof vi.fn> };

function mount(
	load: () => Promise<DashboardData>, api: Partial<OsApiClient> = {}, actions: boolean | null = true,
	loadRuntime?: ( current: DashboardData, cheap: boolean ) => Promise<DashboardData>,
	reauthenticate?: () => void, recoveryHref?: string,
): MountedDashboard {
	const root = document.createElement( "div" );
	document.body.replaceChildren( root );
	const toast = vi.fn();
	const controller = mountDashboard( {
		mount: root,
		api: api as OsApiClient,
		...( actions === null ? {} : { actions } ),
		load,
		...( loadRuntime ? { loadRuntime } : {} ),
		...( reauthenticate ? { reauthenticate } : {} ),
		...( recoveryHref ? { recoveryHref } : {} ),
		toast,
		ctx: { prompt: vi.fn( () => null ), confirm: vi.fn( () => true ) },
	} );
	controllers.push( controller );
	return Object.assign( controller, { toast } );
}

async function tick( ms = 0 ): Promise<void> {
	await vi.advanceTimersByTimeAsync( ms );
}

beforeEach( () => {
	vi.useFakeTimers();
	vi.setSystemTime( 0 );
	hidden = false;
	Object.defineProperty( document, "hidden", { configurable: true, get: () => hidden } );
	online = true;
	Object.defineProperty( navigator, "onLine", { configurable: true, get: () => online } );
	vi.stubGlobal( "fetch", vi.fn( async () => ( { ok: false } as Response ) ) );
} );

afterEach( () => {
	controllers.splice( 0 ).forEach( ( controller ) => controller.destroy() );
	delete ( document as unknown as { hidden?: boolean } ).hidden;
	delete ( navigator as unknown as { onLine?: boolean } ).onLine;
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
} );

describe( "dashboard host polling", () => {
	it( "keeps the navigation shell visible during initial loading", () => {
		mount( () => new Promise<DashboardData>( () => undefined ) );
		expect( document.querySelector( '[role="tablist"]' ) ).not.toBeNull();
		expect( document.querySelectorAll( '[role="tab"][disabled]' ) ).toHaveLength( 7 );
		expect( document.querySelector( '[role="status"]' )?.textContent ).toContain( "Loading" );
	} );

	it( "polls at 4s and backs off 8s, 16s, 30s before resetting on success", async () => {
		const load = vi.fn()
			.mockResolvedValueOnce( data )
			.mockRejectedValueOnce( new Error( "one" ) )
			.mockRejectedValueOnce( new Error( "two" ) )
			.mockRejectedValueOnce( new Error( "three" ) )
			.mockResolvedValue( data );
		mount( load );
		await tick();
		expect( load ).toHaveBeenCalledTimes( 1 );

		await tick( 4000 );
		expect( load ).toHaveBeenCalledTimes( 2 );
		await tick( 7999 );
		expect( load ).toHaveBeenCalledTimes( 2 );
		await tick( 1 );
		expect( load ).toHaveBeenCalledTimes( 3 );
		await tick( 16000 );
		expect( load ).toHaveBeenCalledTimes( 4 );
		await tick( 30000 );
		expect( load ).toHaveBeenCalledTimes( 5 );
		await tick( 4000 );
		expect( load ).toHaveBeenCalledTimes( 6 );
	} );

	it( "bootstraps once, polls runtime, and refreshes relevant configuration every 20s", async () => {
		const load = vi.fn( async () => data );
		const loadRuntime = vi.fn( async ( current: DashboardData ) => current );
		mount( load, {}, true, loadRuntime );
		await tick();
		expect( load ).toHaveBeenCalledOnce();
		expect( loadRuntime ).not.toHaveBeenCalled();

		await tick( 4000 );
		expect( loadRuntime ).toHaveBeenLastCalledWith( data, false );
		( document.querySelector( '[data-tab="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		expect( load ).toHaveBeenCalledTimes( 2 );
		await tick( 20000 );
		expect( loadRuntime ).toHaveBeenLastCalledWith( data, true );
		expect( loadRuntime ).toHaveBeenCalledTimes( 5 );
		expect( load ).toHaveBeenCalledTimes( 3 );
	} );

	it( "uses the cheap status refresh while the Stations view is active", async () => {
		const load = vi.fn( async () => data );
		const loadRuntime = vi.fn( async ( current: DashboardData ) => current );
		mount( load, {}, true, loadRuntime );
		await tick();
		( document.querySelector( '[data-tab="Stations"]' ) as HTMLButtonElement ).click();
		await tick();
		await tick( 4000 );
		expect( loadRuntime ).toHaveBeenLastCalledWith( data, true );
	} );

	it( "refreshes /jc immediately when returning to Status from a cheap-polled view", async () => {
		const load = vi.fn( async () => data );
		const loadRuntime = vi.fn( async ( current: DashboardData ) => current );
		mount( load, {}, true, loadRuntime );
		await tick();
		( document.querySelector( '[data-tab="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		loadRuntime.mockClear();
		( document.querySelector( '[data-tab="Status"]' ) as HTMLButtonElement ).click();
		await tick();
		expect( loadRuntime ).toHaveBeenCalledWith( data, false );
	} );

	it( "shows stale at 12s and unreachable at 30s since the last success", async () => {
		const load = vi.fn()
			.mockResolvedValueOnce( data )
			.mockRejectedValue( new Error( "down" ) );
		const controller = mount( load );
		await tick();
		await tick( 11999 );
		expect( controller.state.connection ).not.toBe( "stale" );
		await tick( 1 );
		expect( controller.state.connection ).toBe( "stale" );
		expect( document.querySelector( '[data-connection-state="stale"]' ) ).not.toBeNull();
		await tick( 18000 );
		expect( controller.state.connection ).toBe( "unreachable" );
		expect( document.querySelector( '[data-connection-state="unreachable"]' ) ).not.toBeNull();
	} );

	it( "marks a terminal error unreachable without automatic retries", async () => {
		const load = vi.fn().mockRejectedValue( Object.assign( new Error( "terminal" ), { terminal: true } ) );
		const controller = mount( load );
		await tick();
		expect( controller.state.connection ).toBe( "unreachable" );
		expect( document.querySelector( ".error-card" ) ).not.toBeNull();
		expect( document.querySelector( "details" )?.textContent ).toContain( "LAN/OTC base" );
		expect( document.body.textContent ).toContain( "No successful controller response yet" );
		await tick( 60000 );
		expect( load ).toHaveBeenCalledOnce();
	} );

	it( "renders runtime authentication separately and restarts login on demand", async () => {
		const reauthenticate = vi.fn();
		const load = vi.fn().mockRejectedValue( new AuthenticationRequiredError() );
		mount( load, {}, true, undefined, reauthenticate );
		await tick();
		expect( document.querySelector( '[data-connection-state="auth-required"]' )?.textContent ).toContain( "Authentication required" );
		( document.querySelector( '[data-action="retry"]' ) as HTMLButtonElement ).click();
		expect( reauthenticate ).toHaveBeenCalledOnce();
		expect( load ).toHaveBeenCalledOnce();
	} );

	it( "renders unsupported policy separately and retries only when requested", async () => {
		const load = vi.fn().mockRejectedValue( new UnsupportedControllerError( "Unapproved build identity." ) );
		mount( load );
		await tick();
		expect( document.body.textContent ).toContain( "Unsupported controller" );
		expect( document.body.textContent ).toContain( "Unapproved build identity" );
		expect( document.querySelector( 'a[href="https://ui.opensprinkler.com/"]' ) ).not.toBeNull();
		online = false;
		window.dispatchEvent( new Event( "offline" ) );
		online = true;
		window.dispatchEvent( new Event( "online" ) );
		await tick();
		expect( load ).toHaveBeenCalledOnce();
		await tick( 60000 );
		expect( load ).toHaveBeenCalledOnce();
		( document.querySelector( '[data-action="retry"]' ) as HTMLButtonElement ).click();
		await tick();
		expect( load ).toHaveBeenCalledTimes( 2 );
	} );

	it( "pauses while hidden and refreshes immediately when visible", async () => {
		const load = vi.fn( async () => data );
		mount( load );
		await tick();
		hidden = true;
		document.dispatchEvent( new Event( "visibilitychange" ) );
		await tick( 60000 );
		expect( load ).toHaveBeenCalledTimes( 1 );

		hidden = false;
		document.dispatchEvent( new Event( "visibilitychange" ) );
		await tick();
		expect( load ).toHaveBeenCalledTimes( 2 );
		await tick( 4000 );
		expect( load ).toHaveBeenCalledTimes( 3 );
	} );

	it( "retains the snapshot while offline and refreshes when the browser comes online", async () => {
		const load = vi.fn( async () => data );
		const controller = mount( load );
		await tick();
		online = false;
		window.dispatchEvent( new Event( "offline" ) );
		expect( controller.state.connection ).toBe( "offline" );
		expect( document.querySelector( '[data-connection-state="offline"]' ) ).not.toBeNull();
		expect( document.querySelector( '[data-tab="Status"]' ) ).not.toBeNull();
		await tick( 60000 );
		expect( load ).toHaveBeenCalledOnce();

		online = true;
		window.dispatchEvent( new Event( "online" ) );
		await tick();
		expect( load ).toHaveBeenCalledTimes( 2 );
		expect( controller.state.connection ).toBe( "connected" );
	} );

	it( "probes the optional companion only once", async () => {
		const fetchMock = vi.mocked( globalThis.fetch );
		mount( vi.fn( async () => data ) );
		await tick();
		await tick( 12000 );
		expect( fetchMock ).toHaveBeenCalledTimes( 1 );
		expect( String( fetchMock.mock.calls[ 0 ][ 0 ] ) ).toContain( "/api/health" );
	} );

	it( "keeps an unchanged settings draft and focus across polls", async () => {
		mount( vi.fn( async () => data ) );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		const input = document.querySelector<HTMLInputElement>( 'input[name="dname"]' )!;
		input.value = "Unsaved draft";
		input.focus();

		await tick( 4000 );
		expect( document.querySelector( 'input[name="dname"]' ) ).toBe( input );
		expect( input.value ).toBe( "Unsaved draft" );
		expect( document.activeElement ).toBe( input );
	} );

	it( "keeps a dirty settings draft when a poll changes controller data", async () => {
		const loadRuntime = vi.fn( async ( current: DashboardData ) => ( {
			...current, jc: { ...current.jc, dname: "Changed on controller" },
		} ) );
		mount( vi.fn( async () => data ), {}, true, loadRuntime );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( 'input[name="dname"]' )!;
		input.value = "Unsaved local draft";
		input.dispatchEvent( new Event( "input", { bubbles: true } ) );
		input.focus();

		await tick( 4000 );
		expect( loadRuntime ).toHaveBeenCalled();
		expect( document.querySelector( 'input[name="dname"]' ) ).toBe( input );
		expect( input.value ).toBe( "Unsaved local draft" );
		expect( document.activeElement ).toBe( input );
	} );

	it( "restores focus when changed runtime data repaints an action", async () => {
		const loadRuntime = vi.fn( async ( current: DashboardData ) => ( {
			...current, jc: { ...current.jc, rd: current.jc.rd === 1 ? 0 as const : 1 as const },
		} ) );
		mount( vi.fn( async () => data ), {}, true, loadRuntime );
		await tick();
		const nav = document.querySelector( '[role="tablist"]' );
		const panel = document.querySelector( '#dashboard-panel' );
		const before = document.querySelector<HTMLButtonElement>( '[data-action="stop-all"]' )!;
		before.focus();
		await tick( 4000 );
		const after = document.querySelector<HTMLButtonElement>( '[data-action="stop-all"]' )!;
		expect( document.querySelector( '[role="tablist"]' ) ).toBe( nav );
		expect( document.querySelector( '#dashboard-panel' ) ).toBe( panel );
		expect( after ).not.toBe( before );
		expect( document.activeElement ).toBe( after );
	} );

	it( "leaves focused navigation untouched when runtime data changes the panel", async () => {
		const loadRuntime = vi.fn( async ( current: DashboardData ) => ( {
			...current, jc: { ...current.jc, rd: current.jc.rd === 1 ? 0 as const : 1 as const },
		} ) );
		mount( vi.fn( async () => data ), {}, true, loadRuntime );
		await tick();
		const nav = document.querySelector( '[role="tablist"]' );
		const panel = document.querySelector( '#dashboard-panel' );
		const tab = document.querySelector<HTMLButtonElement>( '[data-tab="Status"]' )!;
		tab.focus();

		await tick( 4000 );
		expect( document.querySelector( '[role="tablist"]' ) ).toBe( nav );
		expect( document.querySelector( '#dashboard-panel' ) ).toBe( panel );
		expect( document.querySelector( '[data-tab="Status"]' ) ).toBe( tab );
		expect( document.activeElement ).toBe( tab );
	} );

	it( "serializes a mutation behind polling and disables writes through verification", async () => {
		let finishPoll!: ( value: DashboardData ) => void;
		let finishVerification!: ( value: DashboardData ) => void;
		const load = vi.fn()
			.mockResolvedValueOnce( data )
			.mockImplementationOnce( () => new Promise( ( resolve ) => { finishPoll = resolve; } ) )
			.mockImplementationOnce( () => new Promise( ( resolve ) => { finishVerification = resolve; } ) );
		const stopAllStations = vi.fn( async () => ( {} ) );
		const controller = mount( load, { stopAllStations } );
		await tick();
		await tick( 4000 );
		const stop = document.querySelector<HTMLButtonElement>( '[data-action="stop-all"]' )!;
		stop.click();
		expect( controller.state.mutationInFlight ).toBe( true );
		expect( stop.disabled ).toBe( true );
		expect( stopAllStations ).not.toHaveBeenCalled();

		finishPoll( data );
		await tick();
		expect( stopAllStations ).toHaveBeenCalledOnce();
		expect( controller.state.mutationInFlight ).toBe( true );
		expect( stop.disabled ).toBe( true );

		finishVerification( data );
		await tick();
		expect( controller.state.mutationInFlight ).toBe( false );
		expect( stop.disabled ).toBe( false );
	} );

	it( "defaults to read-only and hard-blocks settings submits", async () => {
		const submitOptions = vi.fn();
		const stopAllStations = vi.fn();
		mount( vi.fn( async () => data ), { submitOptions, stopAllStations }, null );
		await tick();
		expect( document.querySelector( '[data-action="stop-all"]' ) ).toBeNull();
		const injectedAction = document.createElement( "button" );
		injectedAction.dataset.action = "stop-all";
		document.querySelector( "[data-host-content]" )!.appendChild( injectedAction );
		injectedAction.click();
		expect( stopAllStations ).not.toHaveBeenCalled();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		const form = document.querySelector<HTMLFormElement>( "form[data-settings]" )!;
		expect( form.querySelector<HTMLButtonElement>( 'button[type="submit"]' )!.disabled ).toBe( true );
		form.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitOptions ).not.toHaveBeenCalled();
	} );

	it( "lets a read-only empty-state CTA open a local draft without enabling Save", async () => {
		const empty = { ...data, jp: { ...data.jp, nprogs: 0, pd: [] } };
		mount( vi.fn( async () => empty ), {}, null );
		await tick();
		( document.querySelector( '[data-tab="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-action="open-settings"][data-target="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		expect( document.querySelector( '[data-settings-section="Programs"]' )?.getAttribute( "aria-selected" ) ).toBe( "true" );
		expect( document.querySelector( "h2" )?.textContent ).toBe( "New Program" );
		expect( document.querySelector<HTMLButtonElement>( 'button[type="submit"]' )?.disabled ).toBe( true );
	} );

	it( "submits only a dirty option and confirms its readback before success", async () => {
		let finishSubmit!: () => void;
		const getOptions = vi.fn().mockResolvedValue( data.jo );
		const getControllerStatus = vi.fn()
			.mockResolvedValueOnce( data.jc )
			.mockResolvedValueOnce( { ...data.jc, dname: "Side Yard" } );
		const submitOptions = vi.fn( () => new Promise<Record<string, unknown>>( ( resolve ) => {
			finishSubmit = () => resolve( {} );
		} ) );
		const mounted = mount( vi.fn( async () => data ), { getOptions, getControllerStatus, submitOptions } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		const form = document.querySelector<HTMLFormElement>( 'form[data-settings="general"]' )!;
		form.querySelector<HTMLInputElement>( '[name="dname"]' )!.value = "Side Yard";
		form.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitOptions ).toHaveBeenCalledWith( { dname: "Side Yard" } );
		const save = form.querySelector<HTMLButtonElement>( 'button[type="submit"]' )!;
		expect( save.textContent ).toBe( "Saving…" );
		expect( save.getAttribute( "aria-busy" ) ).toBe( "true" );
		expect( mounted.toast ).not.toHaveBeenCalled();

		finishSubmit();
		await tick();
		expect( getOptions ).toHaveBeenCalledTimes( 2 );
		expect( getControllerStatus ).toHaveBeenCalledTimes( 2 );
		expect( mounted.toast ).toHaveBeenCalledWith( "General settings saved." );
		expect( document.querySelector( 'button[type="submit"]' )?.textContent ).toBe( "Save" );
	} );

	it( "resets polling backoff after a verified option readback", async () => {
		const load = vi.fn( async () => data );
		const loadRuntime = vi.fn()
			.mockRejectedValueOnce( new Error( "transient" ) )
			.mockImplementation( async ( current: DashboardData ) => current );
		const getOptions = vi.fn().mockResolvedValue( data.jo );
		const getControllerStatus = vi.fn()
			.mockResolvedValueOnce( data.jc )
			.mockResolvedValueOnce( { ...data.jc, dname: "Recovered Yard" } );
		const submitOptions = vi.fn().mockResolvedValue( {} );
		mount( load, { getOptions, getControllerStatus, submitOptions }, true, loadRuntime );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		await tick( 4000 );
		expect( loadRuntime ).toHaveBeenCalledTimes( 1 );

		const input = document.querySelector<HTMLInputElement>( '[name="dname"]' )!;
		input.value = "Recovered Yard";
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitOptions ).toHaveBeenCalledOnce();

		await tick( 3999 );
		expect( loadRuntime ).toHaveBeenCalledTimes( 1 );
		await tick( 1 );
		expect( loadRuntime ).toHaveBeenCalledTimes( 2 );
	} );

	it( "sends no command when option values are unchanged", async () => {
		const getOptions = vi.fn();
		const getControllerStatus = vi.fn();
		const submitOptions = vi.fn();
		const mounted = mount( vi.fn( async () => data ), { getOptions, getControllerStatus, submitOptions } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		const form = document.querySelector<HTMLFormElement>( 'form[data-settings="general"]' )!;
		form.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( getOptions ).not.toHaveBeenCalled();
		expect( getControllerStatus ).not.toHaveBeenCalled();
		expect( submitOptions ).not.toHaveBeenCalled();
		expect( mounted.toast ).toHaveBeenCalledWith( "No changes to save." );
	} );

	it( "keeps the draft and sends no command when a fresh read conflicts", async () => {
		const getOptions = vi.fn().mockResolvedValue( data.jo );
		const getControllerStatus = vi.fn().mockResolvedValue( { ...data.jc, dname: "Changed elsewhere" } );
		const submitOptions = vi.fn();
		mount( vi.fn( async () => data ), { getOptions, getControllerStatus, submitOptions } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="dname"]' )!;
		input.value = "My local draft";
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitOptions ).not.toHaveBeenCalled();
		expect( document.querySelector( '[data-conflict] h2' )?.textContent ).toBe( "Controller changed" );
		expect( document.querySelector<HTMLInputElement>( '[name="dname"]' ) ).toBe( input );
		expect( input.value ).toBe( "My local draft" );
		expect( document.activeElement ).toBe( document.querySelector( '[data-conflict] h2' ) );
	} );

	it( "does not report success when option readback mismatches", async () => {
		const getOptions = vi.fn().mockResolvedValue( data.jo );
		const getControllerStatus = vi.fn().mockResolvedValue( data.jc );
		const submitOptions = vi.fn().mockResolvedValue( {} );
		const mounted = mount( vi.fn( async () => data ), { getOptions, getControllerStatus, submitOptions } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="dname"]' )!;
		input.value = "Unconfirmed";
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitOptions ).toHaveBeenCalledWith( { dname: "Unconfirmed" } );
		expect( mounted.toast ).toHaveBeenCalledWith( expect.stringContaining( "did not confirm" ), true );
		expect( mounted.toast ).not.toHaveBeenCalledWith( "General settings saved." );
	} );

	it( "submits only dirty zone fields after a fresh /jn guard and exact readback", async () => {
		let stations = data.jn;
		const getStations = vi.fn( async () => stations );
		const submitStations = vi.fn( async ( candidate: Parameters<OsApiClient["submitStations"]>[ 0 ] ) => {
			expect( candidate ).toEqual( { fwv: 221, names: { 0: "Front Garden" }, disabled: [ 1 ], groups: { 0: 2 } } );
			stations = {
				...stations,
				snames: [ "Front Garden", ...stations.snames.slice( 1 ) ],
				stn_dis: [ 1 ], stn_grp: [ 2, ...stations.stn_grp.slice( 1 ) ],
			};
			return {};
		} );
		const mounted = mount( vi.fn( async () => data ), { getStations, submitStations } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Stations"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="name_0"]' )!;
		input.value = "Front Garden";
		document.querySelector<HTMLInputElement>( '[name="dis_0"]' )!.checked = true;
		document.querySelector<HTMLSelectElement>( '[name="grp_0"]' )!.value = "2";
		input.dispatchEvent( new Event( "input", { bubbles: true } ) );
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( getStations ).toHaveBeenCalledTimes( 2 );
		expect( submitStations ).toHaveBeenCalledOnce();
		expect( mounted.toast ).toHaveBeenCalledWith( "Zone settings saved." );
	} );

	it( "keeps the zone draft when a dirty /jn source field changed remotely", async () => {
		const changed = { ...data.jn, snames: [ "Remote rename", ...data.jn.snames.slice( 1 ) ] };
		const getStations = vi.fn().mockResolvedValue( changed );
		const submitStations = vi.fn();
		mount( vi.fn( async () => data ), { getStations, submitStations } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Stations"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="name_0"]' )!;
		input.value = "Local rename";
		input.dispatchEvent( new Event( "input", { bubbles: true } ) );
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitStations ).not.toHaveBeenCalled();
		expect( document.querySelector( '[data-conflict] h2' )?.textContent ).toBe( "Controller changed" );
		expect( input.value ).toBe( "Local rename" );
	} );

	it( "does not report zone success when the exact /jn readback mismatches", async () => {
		const getStations = vi.fn().mockResolvedValue( data.jn );
		const submitStations = vi.fn().mockResolvedValue( {} );
		const mounted = mount( vi.fn( async () => data ), { getStations, submitStations } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Stations"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="name_0"]' )!;
		input.value = "Unconfirmed zone";
		input.dispatchEvent( new Event( "input", { bubbles: true } ) );
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitStations ).toHaveBeenCalledOnce();
		expect( mounted.toast ).toHaveBeenCalledWith( expect.stringContaining( "did not confirm" ), true );
		expect( mounted.toast ).not.toHaveBeenCalledWith( "Zone settings saved." );
	} );

	it( "links an invalid network field to an inline summary and sends no request", async () => {
		const getOptions = vi.fn();
		const getControllerStatus = vi.fn();
		const submitOptions = vi.fn();
		mount( vi.fn( async () => data ), { getOptions, getControllerStatus, submitOptions } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Network"]' ) as HTMLButtonElement ).click();
		await tick();
		const input = document.querySelector<HTMLInputElement>( '[name="ip"]' )!;
		input.value = "192.168.1.999";
		input.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( document.querySelector( '[data-validation-summary]' )?.textContent ).toMatch( /octet/i );
		expect( input.getAttribute( "aria-invalid" ) ).toBe( "true" );
		expect( input.getAttribute( "aria-describedby" ) ).toBe( "network-validation-summary f-ip-error" );
		expect( document.querySelector( '[data-validation-summary] a' )?.getAttribute( "href" ) ).toBe( "#f-ip" );
		expect( document.querySelector( '[data-field-error]' )?.textContent ).toMatch( /octet/i );
		expect( document.activeElement ).toBe( input );
		expect( getOptions ).not.toHaveBeenCalled();
		expect( getControllerStatus ).not.toHaveBeenCalled();
		expect( submitOptions ).not.toHaveBeenCalled();
	} );

	it( "fresh-guards a program create and confirms the exact tuple before success", async () => {
		let programs = data.jp;
		const getPrograms = vi.fn( async () => programs );
		const submitProgram = vi.fn( async ( pid: number, input: ProgramInput ) => {
			expect( pid ).toBe( -1 );
			const stored = tuple( input );
			if ( stored[ 6 ][ 0 ] === 0 ) stored[ 6 ] = [ 0, 33, 415 ];
			programs = { ...programs, nprogs: programs.nprogs + 1, pd: [ ...programs.pd, stored ] };
			return {};
		} );
		const load = vi.fn( async () => ( { ...data, jp: programs } ) );
		const mounted = mount( load, { getPrograms, submitProgram } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		const name = document.querySelector<HTMLInputElement>( '[name="name"]' )!;
		name.value = "New schedule";
		const duration = document.querySelector<HTMLInputElement>( '[name="dur_0"]' )!;
		duration.value = "10";
		duration.dispatchEvent( new Event( "input", { bubbles: true } ) );
		duration.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( getPrograms ).toHaveBeenCalledTimes( 2 );
		expect( submitProgram ).toHaveBeenCalledOnce();
		expect( mounted.toast ).toHaveBeenCalledWith( "Program created." );
	} );

	it( "does not submit a program when the fresh source list changed", async () => {
		const changed = { ...data.jp, pd: data.jp.pd.map( ( program ) => [ ...program.slice( 0, 5 ), "Changed elsewhere", program[ 6 ] ] as OSProgram ) };
		const getPrograms = vi.fn().mockResolvedValue( changed );
		const submitProgram = vi.fn();
		mount( vi.fn( async () => data ), { getPrograms, submitProgram } );
		await tick();
		( document.querySelector( '[data-tab="Settings"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-settings-section="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		const name = document.querySelector<HTMLInputElement>( '[name="name"]' )!;
		name.value = "New schedule";
		const duration = document.querySelector<HTMLInputElement>( '[name="dur_0"]' )!;
		duration.value = "10";
		duration.dispatchEvent( new Event( "input", { bubbles: true } ) );
		duration.form!.dispatchEvent( new Event( "submit", { bubbles: true, cancelable: true } ) );
		await tick();
		expect( submitProgram ).not.toHaveBeenCalled();
		expect( document.body.textContent ).toContain( "Controller changed" );
		expect( duration.value ).toBe( "10" );
	} );

	it( "fresh-guards and verifies a program enable change", async () => {
		let programs = data.jp;
		const getPrograms = vi.fn( async () => programs );
		const setProgramEnabled = vi.fn( async ( pid: number, enabled: boolean ) => {
			const changed = structuredClone( programs.pd ) as OSProgram[];
			changed[ pid ]![ 0 ] = enabled ? changed[ pid ]![ 0 ] | 1 : changed[ pid ]![ 0 ] & ~1;
			programs = { ...programs, pd: changed };
			return {};
		} );
		const load = vi.fn( async () => ( { ...data, jp: programs } ) );
		const mounted = mount( load, { getPrograms, setProgramEnabled } );
		await tick();
		( document.querySelector( '[data-tab="Programs"]' ) as HTMLButtonElement ).click();
		await tick();
		( document.querySelector( '[data-action="program-toggle"]' ) as HTMLButtonElement ).click();
		await tick();
		expect( getPrograms ).toHaveBeenCalledTimes( 2 );
		expect( setProgramEnabled ).toHaveBeenCalledWith( 0, false );
		expect( mounted.toast ).toHaveBeenCalledWith( "Program disabled." );
	} );
} );
