/**
 * Weather configuration — adjustment method (uwt), California restriction (wto.cali), location,
 * and weather provider + API key (merged into the existing wto JSON so
 * other wto fields like Zimmerman baselines / Monthly scales are preserved). Writes via /co.
 */
import type { JcResponse, JoResponse } from "../../api/types";
import { selectField, textField, passwordField, checkboxField } from "../../ui/form";
import { infoNote } from "../../ui/help";
import { encodeUwt, escapeJsonForFirmware, inputNumber, validateFirmwareString } from "../../api/encode";
import { ADJUSTMENT_METHODS } from "../../api/diagnostics";

export type FormValues = Record<string, string | boolean >;

const PROVIDERS = [
	{ value: "", label: "(unchanged / default)" }, { value: "Apple", label: "Apple Weather" },
	{ value: "OWM", label: "OpenWeather" }, { value: "WU", label: "Weather Underground (PWS)" },
	{ value: "PW", label: "PirateWeather" }, { value: "AW", label: "AccuWeather" },
	{ value: "OpenMeteo", label: "Open-Meteo" }, { value: "DWD", label: "Bright Sky + DWD" },
];

export function renderWeatherConfig( jo: JoResponse, jc: JcResponse ): string {
	const method = jo.uwt & 0x7f;
	const wto = ( jc.wto ?? {} ) as Record<string, unknown>;
	const restriction = wto.cali === 1 || wto.cali === true;
	const hasKey = typeof wto.key === "string" && wto.key !== "";
	const provider = typeof wto.provider === "string" ? wto.provider : "";
	const methodOpts = ADJUSTMENT_METHODS.map( ( label, value ) => ( { value, label } ) );

	return `<section aria-label="Weather settings"><h2>Weather</h2>` +
		infoNote( "How weather adjusts watering, and which service provides it." ) +
		`<form class="settings" data-settings="weather">` +
		selectField( "method", "Adjustment method", methodOpts, method, "How weather changes the watering amount." ) +
		checkboxField( "restriction", "Enable California restriction", restriction,
			"Use the controller's California watering restriction." ) +
		textField( "loc", "Location (lat,long)", jc.loc || "", { placeholder: "37.5,-122.3", help: "Used to fetch weather." } ) +
		selectField( "provider", "Weather provider", PROVIDERS, provider ) +
		passwordField( "key", "Weather API key", { placeholder: hasKey ? "Stored — blank keeps it" : "Provider key, if required" } ) +
		( hasKey ? checkboxField( "clearKey", "Clear stored API key", false ) : "" ) +
		`<button type="submit" class="action primary" data-save="weather">Save</button>` +
		`</form></section>`;
}

/**
 * Map read values -> /co params, merging provider/key/restriction into the existing wto object.
 * A blank location or key is unchanged; clearing a stored key requires the explicit checkbox.
 */
export function buildWeatherOptions(
	v: FormValues, currentWto: Record<string, unknown> = {},
): Record<string, string | number > {
	const wto: Record<string, unknown> = { ...currentWto };
	if ( typeof v.provider === "string" && v.provider !== "" ) wto.provider = v.provider;
	if ( v.clearKey ) wto.key = "";
	else if ( typeof v.key === "string" && v.key.trim() !== "" ) wto.key = v.key;
	if ( v.restriction ) wto.cali = 1;
	else if ( "cali" in currentWto ) wto.cali = 0;
	const encodedWto = validateFirmwareString( escapeJsonForFirmware( wto ), "key" );
	const out: Record<string, string | number > = {
		uwt: encodeUwt( inputNumber( v.method, "method", 0, ADJUSTMENT_METHODS.length - 1 ) ),
		wto: encodedWto,
	};
	const loc = typeof v.loc === "string" ? v.loc.trim() : "";
	if ( loc !== "" ) out.loc = validateFirmwareString( loc, "loc", true );
	return out;
}
