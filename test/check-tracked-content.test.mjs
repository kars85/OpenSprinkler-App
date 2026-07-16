import assert from "node:assert/strict";
import test from "node:test";
import { scanText } from "../scripts/check-tracked-content.mjs";

test( "reports locations without echoing secret values", () => {
	const contents = "safe\n  export OS_" + "PW=real-value\nhttp://192.168.1.22/\n--" + "pw 'real-value'";
	const findings = scanText( "docs/runbook.md", contents );
	assert.deepEqual( findings.map( ( finding ) => [ finding.line, finding.rule ] ), [
		[ 3, "private IPv4 address in tracked documentation" ],
		[ 2, "literal credential environment assignment" ],
		[ 4, "literal password command argument" ],
	] );
	assert.equal( JSON.stringify( findings ).includes( "real-value" ), false );
} );

test( "allows placeholders, reserved examples, and source-code LAN fixtures", () => {
	assert.deepEqual( scanText( ".env.example", "CONTROLLER_PW=<controller-password>" ), [] );
	assert.deepEqual( scanText( "docs/runbook.md", "export OS_PW=$CONTROLLER_PASSWORD\n--pw '<password>'" ), [] );
	assert.deepEqual( scanText( "docs/runbook.md", "?pw=<md5>" ), [] );
	assert.deepEqual( scanText( "test/example.ts", "const base = 'http://192.168.1.22/'" ), [] );
	assert.deepEqual( scanText( "test/example.ts", "OT000000000000000000000000000000" ), [] );
} );
