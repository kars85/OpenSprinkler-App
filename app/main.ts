/**
 * Phase-1 production app entry. Boots the read-only dashboard against a real device through the
 * shared host controller. Password-protected devices use hash-only authentication.
 *
 * Device base resolution:
 *   - `?base=http://192.168.1.50/`  → explicit device (LAN) or an OTC forward URL (remote)
 *   - otherwise the full page URL path → preserves injected LAN and OTC forwarding bases
 */
import "../www/src/ui/system.css";
import {
	BrowserDeviceSeam, isHostedMixedContent, normalizeDeviceBase, readFirmwareGlobals, safeRecoveryHref,
	resolveDeviceBaseFromLocation,
} from "../www/src/seam/device";
import {
	AuthenticationRequiredError, isPreAuthFallback, OsApiClient, requirePreAuthFloor, requireSupportedOptions,
	UnsupportedControllerError,
} from "../www/src/api/client";
import type { JoResponse } from "../www/src/api/types";
import type { DashboardData } from "../www/src/views/dashboard";
import { stationStatusBits } from "../www/src/api/decode";
import { mountDashboard, renderLoadingShell } from "../www/src/views/host";
import { runLogin } from "../www/src/auth/login";
import { errorCard, unsupportedCard } from "../www/src/ui/help";

function qp( name: string ): string | undefined {
	return new URLSearchParams( location.search ).get( name ) ?? undefined;
}

const { ver, ipas } = readFirmwareGlobals();
const explicitBase = qp( "base" );
const baseUrl = explicitBase
	? normalizeDeviceBase( explicitBase )
	: ver !== undefined ? resolveDeviceBaseFromLocation( location.href ) : "";
let pwHash = qp( "pwhash" );

const mount = document.getElementById( "app" ) as HTMLElement;
mount.innerHTML = renderLoadingShell();

/** A minimal toast banner appended to the body for action/settings feedback (live region). */
const toastEl = document.createElement( "div" );
toastEl.className = "toast";
toastEl.setAttribute( "aria-atomic", "true" );
document.body.appendChild( toastEl );
function toast( message: string, isError = false ): void {
	toastEl.textContent = message;
	toastEl.className = isError ? "toast err show" : "toast show";
	// Errors are assertive (role=alert) so failures are announced promptly; success is polite.
	toastEl.setAttribute( "role", isError ? "alert" : "status" );
	toastEl.setAttribute( "aria-live", isError ? "assertive" : "polite" );
	window.setTimeout( () => { if ( toastEl.textContent === message ) { toastEl.className = "toast"; toastEl.textContent = ""; } }, 4000 );
}

async function boot(): Promise<void> {
	if ( !baseUrl ) throw new UnsupportedControllerError( "A LAN or OTC device base is required." );
	if ( isHostedMixedContent( location.href, baseUrl ) ) {
		throw new UnsupportedControllerError( "A hosted HTTPS app cannot connect directly to a plain-HTTP LAN controller. Use the device-loaded UI or OTC." );
	}

	const preAuthApi = new OsApiClient( new BrowserDeviceSeam( { baseUrl } ) );
	let preAuthOptions: JoResponse | undefined;
	let fwv: number;
	if ( ver === undefined ) {
		const probeRaw = await preAuthApi.probeOptions();
		fwv = requirePreAuthFloor( probeRaw );
		const probe = probeRaw as Partial<JoResponse>;
		if ( !isPreAuthFallback( probe ) ) preAuthOptions = requireSupportedOptions( probe );
	} else {
		fwv = requirePreAuthFloor( ver );
	}
	if ( ipas !== 1 && !pwHash && !preAuthOptions ) {
		pwHash = await runLogin( mount, baseUrl );
	}
	let api = new OsApiClient( new BrowserDeviceSeam( { baseUrl, ver: fwv, ipas, pwHash } ) );
	try {
		requireSupportedOptions( preAuthOptions ?? await api.getOptions() );
	} catch ( e ) {
		if ( !( e instanceof AuthenticationRequiredError ) || ipas === 1 ) throw e;
		pwHash = await runLogin( mount, baseUrl );
		api = new OsApiClient( new BrowserDeviceSeam( { baseUrl, ver: fwv, ipas, pwHash } ) );
		requireSupportedOptions( await api.getOptions() );
	}
	const load = async (): Promise<DashboardData> => {
		const [ jc, jo, jn, je, jp, jl ] = await Promise.all( [
			api.getControllerStatus(), api.getOptions().then( requireSupportedOptions ), api.getStations(), api.getSpecialStations(), api.getPrograms(), api.getLogs(),
		] );
		return { jc, jo, jn, je, jp, jl };
	};
	const loadRuntime = async ( current: DashboardData, cheap: boolean ): Promise<DashboardData> => {
		if ( cheap ) {
			const js = await api.getStatus();
			return { ...current, jc: { ...current.jc, sbits: stationStatusBits( js.sn ) } };
		}
		return { ...current, jc: await api.getControllerStatus() };
	};
	mountDashboard( {
		mount, api, load, loadRuntime, toast,
		reauthenticate: () => location.reload(),
		recoveryHref: safeRecoveryHref( baseUrl ),
		ctx: { prompt: ( m, d ) => window.prompt( m, d ), confirm: ( m ) => window.confirm( m ) },
	} );
}

boot().catch( ( e ) => {
	mount.innerHTML = e instanceof UnsupportedControllerError ? unsupportedCard( e.message ) : errorCard( String( e ) );
	// At boot failure the host click-listener isn't mounted yet, so wire retry to a full reload.
	mount.querySelector<HTMLButtonElement>( '[data-action="retry"]' )?.addEventListener( "click", () => location.reload() );
} );
