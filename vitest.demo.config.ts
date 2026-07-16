import { defineConfig } from "vitest/config";

export default defineConfig( {
	test: { include: [ "test/firmware-demo-contract.spec.ts" ], environment: "node", testTimeout: 30000 },
} );
