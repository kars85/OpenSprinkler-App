/**
 * Dashboard host controller — the single place that turns the pure render + the data/command layers
 * into an interactive app. Used by both the demo (mocked transport) and app/ (real device). It owns
 * the active tab / settings-section state, delegates clicks to dispatchAction(), and maps settings
 * form submits to the tested build*() mappers + typed commands. Re-fetches after a successful write.
 */
import {
	AuthenticationRequiredError, requireSupportedOptions, UnsupportedControllerError, type OsApiClient,
} from "../api/client";
import type { JcResponse, JoResponse, OSProgram } from "../api/types";
import { DASHBOARD_TABS, renderDashboard, type DashboardData, type DashboardTab } from "./dashboard";
import type { SettingsSection } from "./settings/index";
import { dispatchAction, type ActionContext } from "./dispatch";
import { readForm } from "../ui/form";
import { buildGeneralOptions } from "./settings/general";
import { buildWeatherOptions } from "./settings/weather";
import { buildNetworkOptions } from "./settings/network";
import { buildStationConfig } from "./settings/stations-edit";
import { buildProgramInput } from "./settings/program-edit";
import {
	encodeProgram, inputNumber, ValidationError, type ProgramInput, type StationConfigInput,
} from "../api/encode";
import { detectCompanion, fetchHistory, fetchRunLog } from "../api/companion";
import { renderHistory } from "./history-view";
import { esc, unsupportedCard } from "../ui/help";

/**
 * If the companion is reachable + healthy, fetch the last 7 days and render the History HTML;
 * otherwise return undefined so the dashboard omits the History tab (FR-21/22).
 */
export async function resolveHistoryHtml( companionBase: string, now: () => number = () => Math.floor( Date.now() / 1000 ) ): Promise<string | undefined> {
	const health = await detectCompanion( companionBase );
	if ( !health ) return undefined;
	const range = { fromTs: now() - 7 * 86400, toTs: now() };
	const [ tel, runs ] = await Promise.all( [ fetchHistory( companionBase, range ), fetchRunLog( companionBase, range ) ] );
	return renderHistory( tel, runs, { stale: !!health.pollerStale } );
}

export interface HostDeps {
	mount: HTMLElement;
	api: OsApiClient;
	/** Explicit write gate; defaults false. Production stays read-only until the cutover gates pass. */
	actions?: boolean;
	/** (Re)fetch the full dashboard data set from the device. */
	load(): Promise<DashboardData>;
	/** Four-second runtime refresh. Production uses `/jc`, or `/js` when `cheap` is sufficient. */
	loadRuntime?( current: DashboardData, cheap: boolean ): Promise<DashboardData>;
	/** prompt/confirm for actions that need input (rain-delay hours, run minutes, deletes). */
	ctx: ActionContext;
	/** Surface a status / error message to the user. */
	toast( message: string, isError?: boolean ): void;
	/** Restart authentication while preserving the current device base. */
	reauthenticate?(): void;
	/** Exact controller recovery endpoint; used only as a link target, never displayed. */
	recoveryHref?: string;
}

export type HostConnectionState = "loading" | "connected" | "updating" | "offline" | "stale" | "unreachable";
export interface DashboardHostState {
	connection: HostConnectionState;
	lastSuccessAt: number | null;
	mutationInFlight: boolean;
}
export interface DashboardController {
	refresh(): Promise<void>;
	destroy(): void;
	readonly state: DashboardHostState;
}

export function renderLoadingShell(): string {
	return `<nav class="tabs" role="tablist" aria-label="Dashboard sections" aria-disabled="true">${ DASHBOARD_TABS.map( ( tab ) =>
		`<button class="tab" role="tab" type="button" disabled aria-selected="false" tabindex="-1"><span class="tab-label">${ tab }</span></button>`,
	).join( "" ) }</nav><div class="tab-content loading" role="status"><span class="spinner" aria-hidden="true"></span><span>Loading…</span></div>`;
}

class ConflictError extends Error {
	constructor() {
		super( "The controller changed after this form was loaded." );
		this.name = "ConflictError";
	}
}

export function mountDashboard( deps: HostDeps ): DashboardController {
	const backoff = [ 4000, 8000, 16000, 30000 ] as const;
	const startedAt = Date.now();
	let data: DashboardData | null = null;
	let lastError: string | null = null;
	let activeTab: DashboardTab | "History" = "Status";
	let settingsSection: SettingsSection = "General";
	let historyHtml: string | undefined;
	let lastSuccessAt: number | null = null;
	let lastConfigAt: number | null = null;
	let failures = 0;
	let loading = false;
	let mutationInFlight = false;
	let terminalKind: "auth" | "unsupported" | "network" | null = null;
	let destroyed = false;
	let pollTimer: number | undefined;
	let freshnessTimer: number | undefined;
	let paintedContent: string | undefined;
	let paintedBanner: string | undefined;
	let draftSnapshot: DashboardData | null = null;
	let queue: Promise<void> = Promise.resolve();

	deps.mount.innerHTML = '<div data-host-banner></div><div data-host-content></div>';

	function state(): DashboardHostState {
		const age = Date.now() - ( lastSuccessAt ?? startedAt );
		const offline = typeof navigator !== "undefined" && navigator.onLine === false;
		const connection: HostConnectionState = offline
			? "offline"
			: terminalKind !== null || age >= 30000
			? "unreachable"
			: age >= 12000
				? "stale"
				: !data
					? "loading"
					: loading ? "updating" : "connected";
		return { connection, lastSuccessAt, mutationInFlight };
	}

	function canMutate(): boolean {
		const connection = state().connection;
		return deps.actions === true && !!data && !mutationInFlight && connection !== "offline" && connection !== "stale" && connection !== "unreachable";
	}

	function canonicalJson( value: unknown ): string {
		if ( Array.isArray( value ) ) return `[${ value.map( canonicalJson ).join( "," ) }]`;
		if ( value && typeof value === "object" ) {
			return `{${ Object.entries( value as Record<string, unknown> ).sort( ( [ a ], [ b ] ) => a.localeCompare( b ) )
				.map( ( [ key, child ] ) => `${ JSON.stringify( key ) }:${ canonicalJson( child ) }` ).join( "," ) }}`;
		}
		return JSON.stringify( value );
	}

	function comparableOption( key: string, value: string | number | undefined ): string | number | undefined {
		if ( key !== "wto" || typeof value !== "string" ) return value;
		try { return canonicalJson( JSON.parse( `{${ value }}` ) ); } catch { return value; }
	}

	function storedOption( key: string, jo: JoResponse, jc: JcResponse ): string | number | undefined {
		if ( key === "dname" ) return jc.dname;
		if ( key === "loc" ) return jc.loc;
		if ( key === "wto" ) return canonicalJson( jc.wto ?? {} );
		const value = jo[ key ];
		return typeof value === "string" || typeof value === "number" ? value : undefined;
	}

	async function saveOptions( candidate: Record<string, string | number>, snapshot: DashboardData ): Promise<boolean> {
		const dirty = Object.fromEntries( Object.entries( candidate ).filter(
			( [ key, value ] ) => storedOption( key, snapshot.jo, snapshot.jc ) !== comparableOption( key, value ),
		) ) as Record<string, string | number>;
		if ( Object.keys( dirty ).length === 0 ) return false;

		const [ freshJoRaw, freshJc ] = await Promise.all( [ deps.api.getOptions(), deps.api.getControllerStatus() ] );
		const freshJo = requireSupportedOptions( freshJoRaw );
		for ( const key of Object.keys( dirty ) ) {
			if ( storedOption( key, snapshot.jo, snapshot.jc ) !== storedOption( key, freshJo, freshJc ) ) {
				throw new ConflictError();
			}
		}

		await deps.api.submitOptions( dirty );
		const [ readJoRaw, readJc ] = await Promise.all( [ deps.api.getOptions(), deps.api.getControllerStatus() ] );
		const readJo = requireSupportedOptions( readJoRaw );
		for ( const [ key, expected ] of Object.entries( dirty ) ) {
			if ( storedOption( key, readJo, readJc ) !== comparableOption( key, expected ) ) {
				throw new Error( "The controller did not confirm the saved settings." );
			}
		}
		data = { ...( data ?? snapshot ), jo: readJo, jc: readJc };
		lastSuccessAt = Date.now();
		lastConfigAt = Date.now();
		lastError = null;
		failures = 0;
		terminalKind = null;
		return true;
	}

	async function saveStations( candidate: StationConfigInput, snapshot: DashboardData ): Promise<boolean> {
		const dirty: StationConfigInput = { fwv: candidate.fwv };
		const names = Object.fromEntries( Object.entries( candidate.names ?? {} ).filter(
			( [ sid, value ] ) => snapshot.jn.snames[ Number( sid ) ] !== value,
		) ) as Record<number, string>;
		if ( Object.keys( names ).length ) dirty.names = names;

		const changedBoards = ( values: number[] | undefined, source: number[] ): number[] | undefined => {
			let result: number[] | undefined;
			values?.forEach( ( value, board ) => {
				if ( value !== ( source[ board ] ?? 0 ) ) {
					result ??= [];
					result[ board ] = value;
				}
			} );
			return result;
		};
		const disabled = changedBoards( candidate.disabled, snapshot.jn.stn_dis );
		const ignoreRain = changedBoards( candidate.ignoreRain, snapshot.jn.ignore_rain );
		if ( disabled ) dirty.disabled = disabled;
		if ( ignoreRain ) dirty.ignoreRain = ignoreRain;

		const groups = Object.fromEntries( Object.entries( candidate.groups ?? {} ).filter(
			( [ sid, value ] ) => ( snapshot.jn.stn_grp[ Number( sid ) ] ?? 0 ) !== value,
		) ) as Record<number, number>;
		if ( Object.keys( groups ).length ) dirty.groups = groups;
		if ( !dirty.names && !dirty.disabled && !dirty.ignoreRain && !dirty.groups ) return false;

		const fresh = await deps.api.getStations();
		const guardNames = ( values: Record<number, string> | undefined ): void => {
			for ( const sid of Object.keys( values ?? {} ).map( Number ) ) {
				if ( fresh.snames[ sid ] !== snapshot.jn.snames[ sid ] ) throw new ConflictError();
			}
		};
		const guardBoards = ( values: number[] | undefined, before: number[], current: number[] ): void => {
			values?.forEach( ( _, board ) => {
				if ( ( current[ board ] ?? 0 ) !== ( before[ board ] ?? 0 ) ) throw new ConflictError();
			} );
		};
		guardNames( dirty.names );
		guardBoards( dirty.disabled, snapshot.jn.stn_dis, fresh.stn_dis );
		guardBoards( dirty.ignoreRain, snapshot.jn.ignore_rain, fresh.ignore_rain );
		for ( const sid of Object.keys( dirty.groups ?? {} ).map( Number ) ) {
			if ( ( fresh.stn_grp[ sid ] ?? 0 ) !== ( snapshot.jn.stn_grp[ sid ] ?? 0 ) ) throw new ConflictError();
		}

		await deps.api.submitStations( dirty );
		const read = await deps.api.getStations();
		for ( const [ sid, expected ] of Object.entries( dirty.names ?? {} ) ) {
			if ( read.snames[ Number( sid ) ] !== expected ) throw new Error( "The controller did not confirm the saved zone settings." );
		}
		const verifyBoards = ( values: number[] | undefined, actual: number[] ): void => {
			values?.forEach( ( expected, board ) => {
				if ( ( actual[ board ] ?? 0 ) !== expected ) throw new Error( "The controller did not confirm the saved zone settings." );
			} );
		};
		verifyBoards( dirty.disabled, read.stn_dis );
		verifyBoards( dirty.ignoreRain, read.ignore_rain );
		for ( const [ sid, expected ] of Object.entries( dirty.groups ?? {} ) ) {
			if ( ( read.stn_grp[ Number( sid ) ] ?? 0 ) !== expected ) throw new Error( "The controller did not confirm the saved zone settings." );
		}
		data = { ...( data ?? snapshot ), jn: read };
		lastSuccessAt = Date.now();
		lastConfigAt = Date.now();
		lastError = null;
		failures = 0;
		terminalKind = null;
		return true;
	}

	function sameProgram( left: unknown, right: unknown ): boolean {
		return JSON.stringify( left ) === JSON.stringify( right );
	}

	function programTuple( input: ProgramInput ): OSProgram {
		const encoded = encodeProgram( input );
		return [
			encoded.v[ 0 ] as number, encoded.v[ 1 ] as number, encoded.v[ 2 ] as number,
			encoded.v[ 3 ] as number[], encoded.v[ 4 ] as number[], encoded.name,
			encoded.dateRange ? [ encoded.dateRange.enable ? 1 : 0, encoded.dateRange.from, encoded.dateRange.to ] : [ 0, 33, 415 ],
		];
	}

	async function saveProgram( input: ProgramInput, snapshot: DashboardData, pid = -1 ): Promise<void> {
		const fresh = await deps.api.getPrograms();
		const sourceMatches = pid < 0
			? fresh.nprogs === snapshot.jp.nprogs && sameProgram( fresh.pd, snapshot.jp.pd )
			: sameProgram( fresh.pd[ pid ], snapshot.jp.pd[ pid ] );
		if ( !sourceMatches ) throw new ConflictError();
		await deps.api.submitProgram( pid, input );
		const read = await deps.api.getPrograms();
		const index = pid < 0 ? fresh.pd.length : pid;
		if ( ( pid < 0 && read.nprogs !== fresh.nprogs + 1 ) || !sameProgram( read.pd[ index ], programTuple( input ) ) ) {
			throw new Error( "The controller did not confirm the saved program." );
		}
		data = { ...( data ?? snapshot ), jp: read };
	}

	async function guardedProgramAction( ds: Record<string, string | undefined>, snapshot: DashboardData ): Promise<string | null> {
		const pid = inputNumber( ds.pid, "program", 0, 255 );
		const source = snapshot.jp.pd[ pid ];
		const fresh = await deps.api.getPrograms();
		if ( !source || !sameProgram( fresh.pd[ pid ], source ) ) throw new ConflictError();
		const msg = await dispatchAction( deps.api, { jp: fresh }, ds, deps.ctx );
		if ( msg === null ) return null;
		const read = await deps.api.getPrograms();
		if ( ds.action === "program-toggle" ) {
			const expected: OSProgram = [
				source[ 0 ], source[ 1 ], source[ 2 ], [ ...source[ 3 ] ], [ ...source[ 4 ] ], source[ 5 ], [ ...source[ 6 ] ],
			];
			expected[ 0 ] = ds.enabled === "1" ? expected[ 0 ] & ~1 : expected[ 0 ] | 1;
			if ( !sameProgram( read.pd[ pid ], expected ) ) throw new Error( "The controller did not confirm the program state." );
		} else {
			const expected = fresh.pd.filter( ( _, index ) => index !== pid );
			if ( read.nprogs !== fresh.nprogs - 1 || !sameProgram( read.pd, expected ) ) {
				throw new Error( "The controller did not confirm the program deletion." );
			}
		}
		data = { ...( data ?? snapshot ), jp: read };
		return msg;
	}

	function syncMutationUi(): void {
		const disabled = !canMutate();
		deps.mount.querySelectorAll<HTMLButtonElement>(
			'button[data-action]:not([data-action="retry"]):not([data-action="open-settings"]):not([data-action="conflict-review"]):not([data-action="conflict-keep"]), form[data-settings] button[type="submit"]',
		).forEach( ( button ) => { button.disabled = disabled; } );
	}

	function bannerHtml(): string {
		const current = state().connection;
		if ( data && terminalKind === "unsupported" ) return unsupportedCard( lastError ?? "This controller is not supported." );
		if ( data && terminalKind === "auth" ) return authCard();
		if ( current === "updating" ) {
			return '<div class="info-note" role="status" data-connection-state="updating">Updating…</div>';
		}
		if ( current === "offline" ) {
			return '<div class="error-card" role="status" data-connection-state="offline">' +
				`<div class="error-title">Offline</div><p class="error-detail">${ successAgeText() } The last controller snapshot is retained. Changes are disabled until the browser is online.</p></div>`;
		}
		if ( current === "stale" ) {
			const seconds = Math.max( 12, Math.floor( ( Date.now() - ( lastSuccessAt ?? startedAt ) ) / 1000 ) );
			return '<div class="info-note" role="status" data-connection-state="stale">' +
				`<span class="status-pill warn">Stale</span> <span>Last updated ${ seconds } seconds ago.</span> ` +
				'<button class="action" type="button" data-action="retry">Retry</button></div>';
		}
		if ( current === "unreachable" && data ) {
			return unreachableCard();
		}
		return "";
	}

	function authCard(): string {
		return '<div class="error-card" role="alert" data-connection-state="auth-required">' +
				'<div class="error-title">Authentication required</div><p class="error-detail">Sign in again to continue with this controller.</p>' +
			'<button class="action primary" type="button" data-action="retry">Sign in</button></div>';
	}

	function successAgeText(): string {
		if ( lastSuccessAt === null ) return "No successful controller response yet.";
		const seconds = Math.max( 0, Math.floor( ( Date.now() - lastSuccessAt ) / 1000 ) );
		return seconds === 0 ? "Last updated just now." : `Last updated ${ seconds } seconds ago.`;
	}

	function unreachableCard(): string {
		const recovery = deps.recoveryHref
			? `<a href="${ esc( deps.recoveryHref ) }">Open /su recovery</a>`
			: "Open <code>/su</code> directly on the controller";
		return '<div class="error-card" role="alert" data-connection-state="unreachable">' +
			'<div class="error-title">Controller unreachable</div>' +
			`<p class="error-detail">${ esc( lastError ?? "No response for 30 seconds." ) } ${ successAgeText() }</p>` +
			`<details><summary>Details</summary><p>Check the configured LAN/OTC base and path. ${ recovery }.</p></details>` +
			'<button class="action primary" type="button" data-action="retry">Retry</button></div>';
	}

	/** Show only the schedule/start fieldset that matches the current select (program editor). */
	function applyConditionalVisibility(): void {
		const sched = deps.mount.querySelector<HTMLSelectElement>( 'select[name="schedType"]' )?.value;
		const start = deps.mount.querySelector<HTMLSelectElement>( 'select[name="startType"]' )?.value;
		deps.mount.querySelectorAll<HTMLElement>( "[data-when]" ).forEach( ( el ) => {
			const w = el.dataset.when;
			el.hidden = !( w === sched || w === start );
		} );
	}

	function patchTopLevelRegions( container: HTMLElement, html: string ): void {
		const template = document.createElement( "template" );
		template.innerHTML = html;
		const next = Array.from( template.content.children );
		const current = Array.from( container.children );

		next.forEach( ( candidate, index ) => {
			const region = current[ index ];
			if ( !region ) {
				container.append( candidate );
				return;
			}
			if ( region.tagName !== candidate.tagName ) {
				region.replaceWith( candidate );
				return;
			}
			if ( region.outerHTML === candidate.outerHTML ) return;

			Array.from( region.attributes ).forEach( ( attr ) => {
				if ( !candidate.hasAttribute( attr.name ) ) region.removeAttribute( attr.name );
			} );
			Array.from( candidate.attributes ).forEach( ( attr ) => {
				if ( region.getAttribute( attr.name ) !== attr.value ) region.setAttribute( attr.name, attr.value );
			} );
			if ( region.innerHTML !== candidate.innerHTML ) region.innerHTML = candidate.innerHTML;
		} );
		current.slice( next.length ).forEach( ( region ) => region.remove() );
	}

	function paint(): void {
		if ( destroyed ) return;
		const current = state().connection;
		const nextContent = data
			? renderDashboard( data, activeTab, { actions: deps.actions === true, settingsSection, historyHtml } )
			: terminalKind === "unsupported"
				? unsupportedCard( lastError ?? "This controller is not supported." )
				: terminalKind === "auth"
					? authCard()
			: current === "unreachable"
				? unreachableCard()
				: renderLoadingShell();
		const content = deps.mount.querySelector<HTMLElement>( "[data-host-content]" )!;
		const preserveDraft = draftSnapshot !== null && content.querySelector( 'form[data-dirty="true"]' ) !== null;
		if ( nextContent !== paintedContent && !preserveDraft ) {
			const focused = content.contains( document.activeElement ) ? document.activeElement as HTMLElement : null;
			const refocusTab = focused?.getAttribute( "role" ) === "tab";
			const focusedId = focused?.id;
			const focusedAction = focused?.dataset.action;
			const focusedSid = focused?.dataset.sid;
			const focusedPid = focused?.dataset.pid;
			patchTopLevelRegions( content, nextContent );
			paintedContent = nextContent;
			applyConditionalVisibility();
			if ( refocusTab ) deps.mount.querySelector<HTMLElement>( '[role="tab"][aria-selected="true"]' )?.focus();
			else if ( focusedId ) document.getElementById( focusedId )?.focus();
			else if ( focusedAction ) {
				const selector = `[data-action="${ focusedAction }"]` +
					( focusedSid === undefined ? "" : `[data-sid="${ focusedSid }"]` ) +
					( focusedPid === undefined ? "" : `[data-pid="${ focusedPid }"]` );
				content.querySelector<HTMLElement>( selector )?.focus();
			}
		}
		const nextBanner = bannerHtml();
		if ( nextBanner !== paintedBanner ) {
			deps.mount.querySelector<HTMLElement>( "[data-host-banner]" )!.innerHTML = nextBanner;
			paintedBanner = nextBanner;
		}
		syncMutationUi();
	}

	function clearPoll(): void {
		if ( pollTimer !== undefined ) window.clearTimeout( pollTimer );
		pollTimer = undefined;
	}

	function clearFreshness(): void {
		if ( freshnessTimer !== undefined ) window.clearTimeout( freshnessTimer );
		freshnessTimer = undefined;
	}

	function armFreshness(): void {
		clearFreshness();
		if ( destroyed || document.hidden ) return;
		const age = Date.now() - ( lastSuccessAt ?? startedAt );
		const delay = age < 12000 ? 12000 - age : age < 30000 ? 30000 - age : 0;
		if ( delay <= 0 ) return;
		freshnessTimer = window.setTimeout( () => {
			freshnessTimer = undefined;
			paint();
			armFreshness();
		}, delay );
	}

	function schedulePoll(): void {
		clearPoll();
		if ( destroyed || document.hidden || mutationInFlight || terminalKind !== null ||
			( typeof navigator !== "undefined" && navigator.onLine === false ) ) return;
		pollTimer = window.setTimeout( () => {
			pollTimer = undefined;
			void enqueueRefresh( false, false );
		}, backoff[ Math.min( failures, backoff.length - 1 ) ] );
	}

	function terminalType( e: unknown ): typeof terminalKind {
		if ( e instanceof AuthenticationRequiredError ) return "auth";
		if ( e instanceof UnsupportedControllerError ) return "unsupported";
		if ( typeof e === "object" && e !== null && ( e as { terminal?: boolean } ).terminal === true ) return "network";
		return null;
	}

	function configRelevant(): boolean {
		return activeTab !== "Status" && activeTab !== "History";
	}

	function cheapRuntimeSuffices(): boolean {
		return activeTab === "Stations" || activeTab === "Programs" || activeTab === "Log" || activeTab === "Settings" || activeTab === "History";
	}

	async function loadDashboard( notifyError: boolean, full: boolean ): Promise<boolean> {
		loading = true;
		paint();
		try {
			const configDue = configRelevant() && Date.now() - ( lastConfigAt ?? 0 ) >= 20000;
			const runtimeLoad = deps.loadRuntime;
			const useFull = full || !data || !runtimeLoad || configDue;
			const next = !useFull && runtimeLoad ? await runtimeLoad( data!, cheapRuntimeSuffices() ) : await deps.load();
			if ( destroyed ) return false;
			data = next;
			if ( useFull ) lastConfigAt = Date.now();
			lastError = null;
			lastSuccessAt = Date.now();
			failures = 0;
			terminalKind = null;
			return true;
		} catch ( e ) {
			if ( destroyed ) return false;
			lastError = String( e );
			failures++;
			terminalKind = terminalType( e );
			if ( notifyError ) deps.toast( lastError, true );
			return false;
		} finally {
			loading = false;
			paint();
			armFreshness();
		}
	}

	function serialize( task: () => Promise<void> ): Promise<void> {
		const result = queue.then( task, task );
		queue = result.catch( () => undefined );
		return result;
	}

	function enqueueRefresh( notifyError: boolean, full: boolean ): Promise<void> {
		if ( destroyed ) return Promise.resolve();
		clearPoll();
		return serialize( async () => { await loadDashboard( notifyError, full ); } ).finally( schedulePoll );
	}

	function refresh(): Promise<void> {
		return enqueueRefresh( true, true );
	}

	async function runAction( ds: Record<string, string | undefined > ): Promise<void> {
		if ( !data || !canMutate() ) return;
		const snapshot = data;
		mutationInFlight = true;
		clearPoll();
		syncMutationUi();
		await serialize( async () => {
			try {
				const guardedProgram = ds.action === "program-toggle" || ds.action === "program-delete";
				const msg = guardedProgram
					? await guardedProgramAction( ds, snapshot )
					: await dispatchAction( deps.api, { jp: snapshot.jp }, ds, deps.ctx );
				if ( msg !== null && await loadDashboard( true, true ) ) deps.toast( msg );
			} catch ( e ) {
				deps.toast( String( e ), true );
			}
		} ).finally( () => {
			mutationInFlight = false;
			paint();
			schedulePoll();
		} );
	}

	async function saveSettings( form: HTMLFormElement ): Promise<void> {
		if ( !data || !canMutate() ) return;
		const snapshot = draftSnapshot ?? data;
		const kind = form.dataset.settings;
		const v = readForm( form );
		const count = parseInt( form.dataset.count ?? "0", 10 );
		const submit = form.querySelector<HTMLButtonElement>( 'button[type="submit"]' );
		const submitLabel = submit?.textContent ?? "";
		mutationInFlight = true;
		form.querySelector( "[data-validation-summary]" )?.remove();
		form.querySelectorAll( "[data-field-error]" ).forEach( ( error ) => error.remove() );
		Array.from( form.elements ).forEach( ( element ) => {
			if ( element instanceof HTMLInputElement || element instanceof HTMLSelectElement ) {
				element.setCustomValidity( "" );
				element.removeAttribute( "aria-invalid" );
				if ( element.getAttribute( "aria-describedby" )?.includes( "validation-summary" ) ) {
					element.removeAttribute( "aria-describedby" );
				}
			}
		} );
		clearPoll();
		if ( submit ) {
			submit.setAttribute( "aria-busy", "true" );
			submit.setAttribute( "aria-live", "polite" );
			submit.textContent = "Saving…";
		}
		syncMutationUi();
		await serialize( async () => {
			try {
				const fwvCombined = snapshot.jo.fwv * 10 + ( snapshot.jo.fwm || 0 );
				let msg = "Settings saved.";
				let readbackVerified = false;
				let changed = true;
				switch ( kind ) {
					case "general": changed = await saveOptions( buildGeneralOptions( v, fwvCombined ), snapshot ); readbackVerified = true; msg = "General settings saved."; break;
					case "weather": changed = await saveOptions( buildWeatherOptions( v, ( snapshot.jc.wto ?? {} ) as Record<string, unknown> ), snapshot ); readbackVerified = true; msg = "Weather settings saved."; break;
					case "network": changed = await saveOptions( buildNetworkOptions( v ), snapshot ); readbackVerified = true; msg = "Network settings saved."; break;
					case "stations": changed = await saveStations( buildStationConfig( v, count, snapshot.jo.fwv ), snapshot ); readbackVerified = true; msg = "Zone settings saved."; break;
					case "program": await saveProgram( buildProgramInput( v, count ), snapshot ); msg = "Program created."; break;
					default: return;
				}
				if ( !changed ) {
					clearDraft();
					deps.toast( "No changes to save." );
				} else if ( readbackVerified || await loadDashboard( true, true ) ) {
					clearDraft();
					deps.toast( msg );
				}
			} catch ( e ) {
				if ( e instanceof ValidationError ) {
					const summary = document.createElement( "div" );
					const summaryId = `${ kind ?? "settings" }-validation-summary`;
					summary.className = "error-card";
					summary.dataset.validationSummary = "";
					summary.id = summaryId;
					summary.setAttribute( "role", "alert" );
					summary.tabIndex = -1;
					form.prepend( summary );
					const field = form.elements.namedItem( e.field );
					if ( field instanceof HTMLInputElement || field instanceof HTMLSelectElement ) {
						const link = document.createElement( "a" );
						link.href = `#${ field.id }`;
						link.textContent = e.message;
						summary.appendChild( link );
						const inline = document.createElement( "p" );
						inline.className = "field-error";
						inline.dataset.fieldError = "";
						inline.id = `${ field.id }-error`;
						inline.textContent = e.message;
						field.closest( ".field" )?.appendChild( inline );
						field.setCustomValidity( e.message );
						field.setAttribute( "aria-invalid", "true" );
						field.setAttribute( "aria-describedby", `${ summaryId } ${ inline.id }` );
						summary.focus();
						field.focus();
						field.reportValidity();
					} else {
						summary.textContent = e.message;
						summary.focus();
					}
				} else if ( e instanceof ConflictError ) {
					const panel = document.createElement( "div" );
					panel.className = "error-card";
					panel.dataset.conflict = "";
					panel.innerHTML = '<h2 tabindex="-1">Controller changed</h2>' +
						'<p>Review the latest controller values or keep this local draft. Nothing was overwritten.</p>' +
						'<div class="action-bar"><button class="action primary" type="button" data-action="conflict-review">Review latest</button>' +
						'<button class="action" type="button" data-action="conflict-keep">Keep draft</button></div>';
					form.prepend( panel );
					panel.querySelector<HTMLElement>( "h2" )?.focus();
				} else {
					deps.toast( String( e ), true );
				}
			}
		} ).finally( () => {
			mutationInFlight = false;
			if ( submit ) {
				submit.textContent = submitLabel;
				submit.removeAttribute( "aria-busy" );
				submit.removeAttribute( "aria-live" );
			}
			paint();
			schedulePoll();
		} );
	}

	const onClick = ( ev: MouseEvent ): void => {
		const target = ev.target as HTMLElement;
		const tab = target.closest<HTMLElement>( "[data-tab]" );
		if ( tab?.dataset.tab ) {
			clearDraft();
			activeTab = tab.dataset.tab as DashboardTab | "History";
			paint();
			void enqueueRefresh( false, configRelevant() );
			return;
		}

		const sec = target.closest<HTMLElement>( "[data-settings-section]" );
		if ( sec?.dataset.settingsSection ) {
			clearDraft();
			settingsSection = sec.dataset.settingsSection as SettingsSection;
			paint();
			void enqueueRefresh( false, true );
			return;
		}

		const action = target.closest<HTMLButtonElement>( "[data-action]" );
		if ( action?.dataset.action ) {
			if ( action.dataset.action === "retry" ) {
				if ( terminalKind === "auth" && deps.reauthenticate ) deps.reauthenticate();
				else void refresh();
				return;
			}
			if ( action.dataset.action === "conflict-review" ) { clearDraft(); void refresh(); return; }
			if ( action.dataset.action === "conflict-keep" ) {
				action.closest<HTMLElement>( "[data-conflict]" )?.remove();
				return;
			}
			if ( action.dataset.action === "open-settings" ) {
				const next = action.dataset.target;
				if ( next === "General" || next === "Weather" || next === "Network" || next === "Stations" || next === "Programs" ) {
					clearDraft();
					activeTab = "Settings";
					settingsSection = next;
					paint();
					void enqueueRefresh( false, true );
				}
				return;
			}
			if ( !canMutate() ) return;
			if ( action.dataset.action === "program-new" ) {
				activeTab = "Settings"; settingsSection = "Programs"; paint(); return;
			}
			// "save-*" submit buttons are handled by the form submit listener.
			if ( action.type !== "submit" ) void runAction( { ...action.dataset } );
		}
	};

	function clearDraft(): void {
		draftSnapshot = null;
		deps.mount.querySelectorAll( 'form[data-dirty="true"]' ).forEach( ( form ) => form.removeAttribute( "data-dirty" ) );
	}

	const onInput = ( ev: Event ): void => {
		const form = ( ev.target as HTMLElement ).closest<HTMLFormElement>( "form[data-settings]" );
		if ( !form || !data ) return;
		if ( draftSnapshot === null ) draftSnapshot = data;
		form.dataset.dirty = "true";
	};

	const onSubmit = ( ev: SubmitEvent ): void => {
		const form = ( ev.target as HTMLElement ).closest<HTMLFormElement>( "form[data-settings]" );
		if ( !form ) return;
		ev.preventDefault();
		if ( canMutate() ) void saveSettings( form );
	};

	// Re-apply program-editor conditional visibility as the schedule/start selects change.
	const onChange = ( ev: Event ): void => {
		const name = ( ev.target as HTMLElement ).getAttribute?.( "name" );
		if ( name === "schedType" || name === "startType" ) applyConditionalVisibility();
	};

	// Roving-tabindex arrow-key navigation for the tablists (WAI-ARIA tabs pattern, auto-activation).
	const onKeydown = ( ev: KeyboardEvent ): void => {
		const tab = ( ev.target as HTMLElement ).closest<HTMLElement>( '[role="tab"]' );
		if ( !tab ) return;
		const list = tab.closest( '[role="tablist"]' );
		if ( !list ) return;
		const tabs = Array.from( list.querySelectorAll<HTMLElement>( '[role="tab"]' ) );
		const idx = tabs.indexOf( tab );
		let next = -1;
		switch ( ev.key ) {
			case "ArrowRight": case "ArrowDown": next = ( idx + 1 ) % tabs.length; break;
			case "ArrowLeft": case "ArrowUp": next = ( idx - 1 + tabs.length ) % tabs.length; break;
			case "Home": next = 0; break;
			case "End": next = tabs.length - 1; break;
			default: return;
		}
		ev.preventDefault();
		tabs[ next ]?.click(); // activates + repaints; paint() restores focus to the active tab
	};

	const onVisibilityChange = (): void => {
		if ( document.hidden ) {
			clearPoll();
			clearFreshness();
			return;
		}
		paint();
		armFreshness();
		if ( terminalKind === null ) void enqueueRefresh( false, false );
	};

	const onOffline = (): void => {
		clearPoll();
		paint();
	};

	const onOnline = (): void => {
		paint();
		if ( terminalKind === null ) void enqueueRefresh( false, false );
	};

	deps.mount.addEventListener( "click", onClick );
	deps.mount.addEventListener( "submit", onSubmit );
	deps.mount.addEventListener( "input", onInput );
	deps.mount.addEventListener( "change", onChange );
	deps.mount.addEventListener( "keydown", onKeydown );
	document.addEventListener( "visibilitychange", onVisibilityChange );
	window.addEventListener( "offline", onOffline );
	window.addEventListener( "online", onOnline );

	paint();
	armFreshness();
	void enqueueRefresh( false, true );
	const companionBase = new URLSearchParams( location.search ).get( "companion" ) || location.origin + "/";
	void resolveHistoryHtml( companionBase ).catch( () => undefined ).then( ( html ) => {
		if ( destroyed ) return;
		historyHtml = html;
		paint();
	} );

	return {
		refresh,
		destroy(): void {
			if ( destroyed ) return;
			destroyed = true;
			clearPoll();
			clearFreshness();
			deps.mount.removeEventListener( "click", onClick );
			deps.mount.removeEventListener( "submit", onSubmit );
			deps.mount.removeEventListener( "input", onInput );
			deps.mount.removeEventListener( "change", onChange );
			deps.mount.removeEventListener( "keydown", onKeydown );
			document.removeEventListener( "visibilitychange", onVisibilityChange );
			window.removeEventListener( "offline", onOffline );
			window.removeEventListener( "online", onOnline );
		},
		get state(): DashboardHostState { return state(); },
	};
}
