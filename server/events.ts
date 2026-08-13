/**
 * Event derivation: turn consecutive telemetry snapshots into plain-English log events.
 *
 * Only transitions the firmware does NOT already record in /jl are emitted here — water level
 * and rain delay changes appear in the controller's own log, so re-deriving them would produce
 * duplicate rows in any merged view. What /jl never shows, and this differ does:
 *   - weather adjustment errors appearing / clearing (jc.wterr)
 *   - the California weather watering restriction engaging / lifting (jc.wtrestr)
 *   - each completed controller weather call (jc.lswc advancing), as a Detail row
 *
 * The baseline is the previous *persisted* sample, so a companion restart never re-emits
 * events: with no baseline (first sample ever, or an unreadable one) nothing is derived.
 */
import { weatherErrorText } from "../www/src/api/diagnostics";
import type { EventRow, StoredTelemetry, TelemetrySample } from "./storage/provider";

/** Firmware sensor types (jo.sn1t/sn2t) whose activation pauses watering. */
const PAUSE_SENSOR_NAMES: Record<number, string> = { 1: "Rain sensor", 3: "Soil sensor" };

export interface SensorTypes { sensor1Type: number; sensor2Type: number; }

function sensorTransition(
	ts: number, name: string, active: boolean, suffix: string,
): EventRow {
	return {
		ts, source: "sensors", level: "normal", label: name.split( " " )[ 0 ]!,
		detail: active
			? `${ name }${ suffix } activated — scheduled watering is paused.`
			: `${ name }${ suffix } cleared; scheduled watering resumes.`,
	};
}

export function diffTelemetryEvents(
	prev: StoredTelemetry | null, cur: TelemetrySample, sensorTypes?: SensorTypes,
): EventRow[] {
	if ( !prev ) return [];
	const out: EventRow[] = [];
	const base = { ts: cur.ts, source: "weather" as const, label: "Weather" };

	// Wired pause-sensor transitions. The firmware's own /jl records an activation only after it
	// ENDS (a retroactive duration row), so an ongoing activation is invisible there — this is the
	// only log surface that can say "the rain sensor is pausing watering right now". A null
	// baseline value (rows from before schema v3) derives nothing rather than a false transition.
	const sensors: Array<[ number | null, number | null, number | undefined, string ]> = [
		[ prev.sensor1, cur.sensor1, sensorTypes?.sensor1Type, "" ],
		[ prev.sensor2, cur.sensor2, sensorTypes?.sensor2Type, " (2)" ],
	];
	for ( const [ was, now, type, suffix ] of sensors ) {
		const name = type === undefined ? undefined : PAUSE_SENSOR_NAMES[ type ];
		if ( !name || was === null || was === undefined || now === null || now === undefined ) continue;
		if ( was !== now ) out.push( sensorTransition( cur.ts, name, now === 1, suffix ) );
	}

	if ( cur.weatherErr !== prev.weatherErr ) {
		out.push( {
			...base, level: "normal",
			detail: cur.weatherErr === 0
				? "Weather service recovered; adjustments are updating again."
				: `Weather adjustment problem: ${ weatherErrorText( cur.weatherErr ) }.`,
		} );
	}
	if ( cur.weatherRestricted !== prev.weatherRestricted ) {
		out.push( {
			...base, level: "normal",
			detail: cur.weatherRestricted
				? "Watering restricted by a weather rule."
				: "Weather watering restriction lifted.",
		} );
	}
	if ( cur.lastWeatherUpdate !== prev.lastWeatherUpdate && cur.lastWeatherUpdate > 0 ) {
		out.push( {
			...base, level: "detail",
			detail: `Controller completed a weather check; water level is ${ cur.waterLevel }%.`,
		} );
	}
	return out;
}
