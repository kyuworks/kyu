// Vendored from https://github.com/dmmulroy/anti-slop @ 6d53855
// (skills/install-anti-slop/assets/anti-slop/effect). Registered, left off.
import { eslintCompatPlugin } from "@oxlint/plugins";

import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";

/** Opt-in Oxlint rules for Effect service and Layer architecture. */
const antiSlopEffectPlugin = eslintCompatPlugin({
	meta: { name: "anti-slop-effect" },
	rules: {
		"no-service-constructor-imports": noServiceConstructorImportsRule,
	},
});

export default antiSlopEffectPlugin;
