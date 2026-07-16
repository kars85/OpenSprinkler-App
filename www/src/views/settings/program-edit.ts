/**
 * Program editor — builds a typed ProgramInput from a form for /cp (create new / overwrite).
 * Covers schedule (weekly/interval/monthly/single-run), start times (fixed up to 4, or repeating),
 * per-station durations, weather use, and odd/even restriction. buildProgramInput() is pure + tested;
 * the encoder (api/encode.ts) turns it into the firmware payload.
 */
import type { JnResponse } from "../../api/types";
import {
	textField, numberField, checkboxField, selectField, type SelectOption,
} from "../../ui/form";
import { esc, infoNote } from "../../ui/help";
import {
	dateToEpochDays, encodeDate, inputNumber, validateFirmwareString, ValidationError,
	type ProgramInput, type ScheduleInput, type StartInput, type StartTimeInput,
} from "../../api/encode";

export type FormValues = Record<string, string | boolean >;

const WEEKDAYS = [ "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun" ];
const TYPE_OPTS: SelectOption[] = [
	{ value: "weekly", label: "Weekly" }, { value: "interval", label: "Interval (every N days)" },
	{ value: "monthly", label: "Monthly (day of month)" }, { value: "singlerun", label: "Single run (one date)" },
];
const REST_OPTS: SelectOption[] = [
	{ value: "none", label: "None" }, { value: "odd", label: "Odd days" }, { value: "even", label: "Even days" },
];
const START_OPTS: SelectOption[] = [
	{ value: "fixed", label: "Fixed times" }, { value: "repeat", label: "Repeating" },
];

/** "HH:MM" -> minutes since midnight (or null if blank/invalid). */
export function parseClock( s: string ): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec( s.trim() );
	if ( !m ) return null;
	const hour = Number( m[ 1 ] ), minute = Number( m[ 2 ] );
	return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

/** "YYYY-MM-DD" -> {year,month,day} (or null). */
function parseDate( s: string ): { year: number; month: number; day: number } | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec( s.trim() );
	if ( !m ) return null;
	const value = { year: +m[ 1 ]!, month: +m[ 2 ]!, day: +m[ 3 ]! };
	const date = new Date( Date.UTC( value.year, value.month - 1, value.day ) );
	return value.year >= 1970 && value.year <= 2149 && date.getUTCFullYear() === value.year &&
		date.getUTCMonth() === value.month - 1 && date.getUTCDate() === value.day ? value : null;
}

export function renderProgramEditor( jn: JnResponse, fwv = 0 ): string {
	const wd = WEEKDAYS.map( ( d, i ) => checkboxField( `wd_${ i }`, d, i < 5 ) ).join( "" );
	const durs = jn.snames.map( ( name, sid ) =>
		numberField( `dur_${ sid }`, esc( name ), 0, { min: 0, max: 1080, help: "Minutes (0 = skip)." } ) ).join( "" );
	const fixedTimes = [ 0, 1, 2, 3 ].map( ( i ) =>
		textField( `t_${ i }`, `Start time ${ i + 1 }`, i === 0 ? "06:00" : "", { placeholder: "HH:MM (blank = unused)" } ) ).join( "" );

	return `<section aria-label="Program editor"><h2>New Program</h2>` +
		infoNote( "Define a watering schedule. Saved to the device via /cp." ) +
		`<form class="settings" data-settings="program" data-count="${ jn.snames.length }">` +
		textField( "name", "Program name", "", { placeholder: "e.g. Morning" } ) +
		checkboxField( "enabled", "Enabled", false ) +
		checkboxField( "useWeather", "Use weather adjustment", true ) +
		selectField( "restriction", "Day restriction", REST_OPTS, "none" ) +
		selectField( "schedType", "Schedule", TYPE_OPTS, "weekly" ) +
		`<fieldset data-when="weekly"><legend>Weekly days</legend>${ wd }</fieldset>` +
		`<fieldset data-when="interval"><legend>Interval</legend>` +
			numberField( "intervalDays", "Every N days", 2, { min: 1, max: 128 } ) +
			numberField( "startingInDays", "Starting in (days)", 0, { min: 0, max: 127 } ) + `</fieldset>` +
		`<fieldset data-when="monthly"><legend>Monthly</legend>` +
			numberField( "dayOfMonth", "Day of month", 1, { min: 0, max: 31, help: "0 = last day." } ) + `</fieldset>` +
		`<fieldset data-when="singlerun"><legend>Single run</legend>` +
			textField( "singleDate", "Date", "", { placeholder: "YYYY-MM-DD" } ) + `</fieldset>` +
		selectField( "startType", "Start type", START_OPTS, "fixed" ) +
		`<fieldset data-when="fixed"><legend>Fixed start times</legend>${ fixedTimes }</fieldset>` +
		`<fieldset data-when="repeat"><legend>Repeating</legend>` +
			textField( "repeatFirst", "First start", "06:00", { placeholder: "HH:MM" } ) +
			numberField( "repeatCount", "Repeat count", 1, { min: 1, max: 255 } ) +
			numberField( "repeatInterval", "Interval (minutes)", 60, { min: 1, max: 1440 } ) + `</fieldset>` +
		`<fieldset><legend>Run times</legend>${ durs }</fieldset>` +
		( fwv >= 220
			? `<fieldset><legend>Date range (optional)</legend>` +
				checkboxField( "useDateRange", "Limit to a seasonal date range", false ) +
				textField( "drFrom", "From", "", { placeholder: "YYYY-MM-DD" } ) +
				textField( "drTo", "To", "", { placeholder: "YYYY-MM-DD" } ) + `</fieldset>`
			: "" ) +
		`<button type="submit" class="action primary" data-save="program">Save program</button>` +
		`</form></section>`;
}

function buildSchedule( v: FormValues ): ScheduleInput {
	switch ( String( v.schedType ) ) {
		case "interval": {
			const intervalDays = inputNumber( v.intervalDays, "intervalDays", 1, 128 );
			const startingInDays = inputNumber( v.startingInDays, "startingInDays", 0, 127 );
			if ( startingInDays >= intervalDays ) throw new ValidationError( "startingInDays", "Starting day must be less than the interval." );
			return { type: "interval", intervalDays, startingInDays };
		}
		case "monthly":
			return { type: "monthly", dayOfMonth: inputNumber( v.dayOfMonth, "dayOfMonth", 0, 31 ) };
		case "singlerun": {
			const d = parseDate( String( v.singleDate ?? "" ) );
			if ( !d ) throw new ValidationError( "singleDate", "Enter a valid date." );
			const epochDays = dateToEpochDays( d.year, d.month, d.day );
			if ( epochDays > 65535 ) throw new ValidationError( "singleDate", "Date is outside the controller's supported range." );
			return { type: "singlerun", epochDays };
		}
		default: {
			const weekdays: number[] = [];
			for ( let i = 0; i < 7; i++ ) if ( v[ `wd_${ i }` ] ) weekdays.push( i );
			if ( weekdays.length === 0 ) throw new ValidationError( "wd_0", "Select at least one weekday." );
			return { type: "weekly", weekdays };
		}
	}
}

function startTimeFromClock( s: string, field: string, required = false ): StartTimeInput {
	if ( s.trim() === "" && !required ) return { kind: "off" };
	const m = parseClock( s );
	if ( m === null ) throw new ValidationError( field, "Enter a valid 24-hour time (HH:MM)." );
	return { kind: "time", minutes: m };
}

function buildStart( v: FormValues ): StartInput {
	if ( String( v.startType ) === "repeat" ) {
		return {
			type: "repeat",
			first: startTimeFromClock( String( v.repeatFirst ?? "" ), "repeatFirst", true ),
			count: inputNumber( v.repeatCount, "repeatCount", 1, 255 ),
			intervalMinutes: inputNumber( v.repeatInterval, "repeatInterval", 1, 1440 ),
		};
	}
	const times = [ 0, 1, 2, 3 ].map( ( i ) => startTimeFromClock( String( v[ `t_${ i }` ] ?? "" ), `t_${ i }` ) );
	if ( times.every( ( time ) => time.kind === "off" ) ) throw new ValidationError( "t_0", "Enter at least one start time." );
	const used = times.filter( ( time ): time is Extract<StartTimeInput, { kind: "time" }> => time.kind === "time" ).map( ( time ) => time.minutes );
	if ( new Set( used ).size !== used.length ) throw new ValidationError( "t_0", "Start times must be unique." );
	return { type: "fixed", times };
}

/** Map read form values -> ProgramInput. `count` = number of stations (for the durations array). */
export function buildProgramInput( v: FormValues, count: number ): ProgramInput {
	const durations: number[] = [];
	for ( let sid = 0; sid < count; sid++ ) {
		const seconds = inputNumber( v[ `dur_${ sid }` ], `dur_${ sid }`, 0, 1080, false ) * 60;
		if ( !Number.isInteger( seconds ) ) throw new ValidationError( `dur_${ sid }`, "Duration must resolve to whole seconds." );
		durations.push( seconds );
	}
	if ( durations.every( ( duration ) => duration === 0 ) ) throw new ValidationError( "dur_0", "Enter a run time for at least one station." );
	const rest = String( v.restriction ?? "none" );
	const name = typeof v.name === "string" ? v.name : "";
	if ( name.trim() === "" ) throw new ValidationError( "name", "Enter a program name." );
	const input: ProgramInput = {
		enabled: !!v.enabled,
		useWeather: !!v.useWeather,
		restriction: rest === "odd" || rest === "even" ? rest : "none",
		schedule: buildSchedule( v ),
		start: buildStart( v ),
		durations,
		name: validateFirmwareString( name, "name", true, 32 ),
	};
	const dr = parseDate( String( v.drFrom ?? "" ) );
	const dr2 = parseDate( String( v.drTo ?? "" ) );
	if ( v.useDateRange && ( !dr || !dr2 ) ) throw new ValidationError( !dr ? "drFrom" : "drTo", "Enter a valid date range." );
	if ( v.useDateRange && dr && dr2 ) {
		input.dateRange = { enable: true, from: encodeDate( dr.month, dr.day ), to: encodeDate( dr2.month, dr2.day ) };
	}
	return input;
}
