/**
 * Weather view — what's adjusting the watering and where it comes from. Closes two novice-UX gaps:
 *   • Multi-Day Levels renders a friendly empty-state instead of a bare "[]" (upstream #289).
 *   • The weather-source footer is descriptive, with "PWS" spelled out (upstream #291).
 *
 * Reads /jc (wls, wtdata, wsp, wterr) + /jo (uwt, wl). Framework-free HTML string, like the other
 * views; interpretation logic lives in api/diagnostics.ts.
 */
import type { JcResponse, JoResponse } from "../api/types";
import { adjustmentMethodName, weatherErrorText, weatherProviderTag, weatherSourceName } from "../api/diagnostics";
import { elapsedSeconds, formatClock, relativeTime } from "../api/time";
import { esc, helpTip, emptyState, infoNote } from "../ui/help";

/** Friendly labels for the weather-data fields the firmware may report in /jc.wtdata. */
const WTDATA_LABELS: Record<string, string> = {
	t: "Mean temp", minT: "Min temp", maxT: "Max temp",
	h: "Mean humidity", minH: "Min humidity", maxH: "Max humidity",
	p: "Total rain", eto: "ETo", wind: "Mean wind", radiation: "Mean radiation",
};

function renderMultiDayLevels( wls: number[] ): string {
	const help = helpTip( "Per-day watering adjustments your weather service applied recently (100% = no change)." );
	if ( !Array.isArray( wls ) || wls.length === 0 ) {
		return `<h3>Multi-Day Levels ${ help }</h3>` +
			emptyState( "None", "Your weather service isn't sending multi-day levels." );
	}
	const items = wls.map( ( v, i ) =>
		`<li><span class="muted">Day ${ i + 1 }</span> <b>${ esc( String( v ) ) }%</b></li>` ).join( "" );
	return `<h3>Multi-Day Levels ${ help }</h3><ol class="wls">${ items }</ol>`;
}

function renderWeatherData( wtdata: Record<string, unknown>, historical = false ): string {
	const heading = historical ? "Last successful Weather data" : "Current Weather Data";
	const keys = Object.keys( wtdata ).filter( ( k ) => k in WTDATA_LABELS && typeof wtdata[ k ] === "number" );
	if ( keys.length === 0 ) {
		return `<h3>${ heading }</h3>` +
			emptyState( "No weather data yet", "The controller hasn't received observations from its weather service.",
				{ label: "Review Weather settings", action: "open-settings", target: "Weather" } );
	}
	const rows = keys.map( ( k ) => {
		const unit = k === "h" || k === "minH" || k === "maxH" ? "%" : "";
		return `<tr><th scope="row">${ esc( WTDATA_LABELS[ k ]! ) }</th>` +
			`<td>${ esc( String( wtdata[ k ] ) ) }${ unit }</td></tr>`;
	} ).join( "" );
	return `<h3>${ heading }</h3>` +
		infoNote( "Values as reported by your weather service (units follow your controller)." ) +
		`<table class="status"><tbody>${ rows }</tbody></table>`;
}

/**
 * Descriptive weather-source footer (upstream #291). Prefers the provider tag from observations;
 * otherwise falls back to the configured weather-service host (/jc.wsp), and spells out PWS.
 */
function renderSourceFooter( jc: JcResponse, jo: JoResponse, historical = false ): string {
	const provider = weatherProviderTag( jc.wtdata );
	const host = typeof jc.wsp === "string" && jc.wsp ? jc.wsp : "";
	const pwsAbbr = `<abbr title="Personal Weather Station">PWS</abbr>`;

	let source: string;
	if ( provider ) {
		source = `${ historical ? "Last successful source" : "Weather source" }: ${ esc( weatherSourceName( provider ) ) }`;
	} else if ( ( jo.uwt & ~( 1 << 7 ) ) === 0 ) {
		source = "Weather source: manual adjustment (no weather service)";
	} else if ( host ) {
		source = `Weather source: service at ${ esc( host ) }`;
	} else {
		source = "Weather source: not reported";
	}

	const hostLine = host ? `<br><span class="muted">Service host: ${ esc( host ) }</span>` : "";
	const pwsLine = ( provider === "local" )
		? `<br><span class="muted">A ${ pwsAbbr } is your own weather station feeding readings to the controller.</span>`
		: "";
	return `<footer class="weather-source">${ source }${ hostLine }${ pwsLine }</footer>`;
}

/** A decorative glyph for the adjustment method: cloud = a weather service drives it, slider = manual. */
function methodGlyph( uwt: number ): string {
	const manual = ( uwt & ~( 1 << 7 ) ) === 0;
	const path = manual
		? `<path d="M4 12h16"/><circle cx="9" cy="12" r="2.5"/>`
		: `<path d="M17.5 18a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 18z"/>`;
	return `<svg class="i-method" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
		`stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ path }</svg>`;
}

export type WeatherHealth = "not-yet-updated" | "update-pending" | "last-update-failed" | "stale" | "current";

export function deriveWeatherHealth( jc: JcResponse, tz: number ): { health: WeatherHealth; age: number | null; clockReview: boolean } {
	if ( jc.lwc === 0 && jc.lswc === 0 ) return { health: "not-yet-updated", age: null, clockReview: false };
	const age = jc.lswc > 0 ? elapsedSeconds( jc.lswc, jc.devt, tz ) : null;
	const clockReview = age !== null && age < 0;
	if ( jc.lwc === 0 && jc.lswc > 0 ) return { health: "update-pending", age, clockReview };
	if ( jc.wterr !== 0 ) return { health: "last-update-failed", age, clockReview };
	if ( jc.lswc === 0 || ( age !== null && age > 86400 ) ) return { health: "stale", age, clockReview };
	return { health: "current", age, clockReview };
}

function renderWeatherAvailability( jc: JcResponse, jo: JoResponse ): { html: string; historical: boolean } {
	const status = deriveWeatherHealth( jc, jo.tz );
	const labels: Record<WeatherHealth, string> = {
		"not-yet-updated": "Not yet updated", "update-pending": "Update pending",
		"last-update-failed": "Last update failed", stale: "Stale", current: "Current",
	};
	const historical = status.health !== "current";
	const error = status.health === "last-update-failed" ? `${ weatherErrorText( jc.wterr ) }. ` : "";
	const last = jc.lswc > 0
		? status.clockReview
			? "Controller clock needs review"
			: `${ formatClock( jc.lswc, jo.tz ) } (${ relativeTime( status.age ?? 0 ) })`
		: "No successful update recorded";
	const staleLast = status.age !== null && status.age > 86400;
	const lastLabel = staleLast ? "Stale last successful decision" : "Last successful weather update";
	const className = status.health === "current" ? "info-note" : "error-card";
	const role = status.health === "current" ? "status" : "alert";
	const effect = jc.wtrestr
		? "Weather restriction is active; weather-enabled schedules are held at 0%."
		: `Current controller effect remains ${ jo.wl }%.`;
	const html = `<div class="${ className }" role="${ role }" data-weather-health="${ status.health }">` +
		`<div class="error-title">Weather health: ${ labels[ status.health ] }</div>` +
		`<p class="error-detail">${ esc( error + effect ) } Non-weather controls remain available.</p>` +
		`<p class="muted">${ lastLabel }: ${ esc( last ) }</p></div>`;
	return { html, historical };
}

export function renderWeather( jc: JcResponse, jo: JoResponse ): string {
	const availability = renderWeatherAvailability( jc, jo );
	const summaryRows = [
		typeof jo.uwt === "number"
			? `<tr><th scope="row">Adjustment method ${ helpTip( "How weather changes the watering amount." ) }</th>` +
				`<td><span class="method-cell">${ methodGlyph( jo.uwt ) }${ esc( adjustmentMethodName( jo.uwt ) ) }</span></td></tr>` : "",
		typeof jo.wl === "number"
			? `<tr><th scope="row">Watering level ${ helpTip( "Current overall watering as a percentage of program durations." ) }</th>` +
				`<td>${ esc( String( jo.wl ) ) }%</td></tr>` : "",
	].join( "" );

	return `<section aria-label="Weather">` +
		`<h2>Weather</h2>` +
		availability.html +
		`<table class="status"><tbody>${ summaryRows }</tbody></table>` +
		renderMultiDayLevels( jc.wls ) +
		renderWeatherData( jc.wtdata, availability.historical ) +
		renderSourceFooter( jc, jo, availability.historical ) +
		`</section>`;
}
