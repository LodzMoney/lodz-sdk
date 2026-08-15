/**
 * The one place a version string enters the compiled output.
 *
 * The literal below is a build-time placeholder and is never a real version.
 * `scripts/stamp-dist.mjs` rewrites it in `dist/version.js` and
 * `dist/cjs/version.js` with the `version` field of this package's
 * package.json, and kills the build if the placeholder is missing, if it
 * appears more than once, or if any copy survives unstamped. package.json is
 * therefore the only source of truth: a hand written constant can no longer
 * drift away from the version that is actually published, because a hand
 * written constant no longer builds.
 *
 * Why a build-time stamp rather than reading package.json at runtime: this
 * package ships an ESM build (`dist/index.js`, the `lodz` bin) and a CommonJS
 * build (`dist/cjs/index.js`) from this same source. Finding package.json at
 * runtime needs `import.meta.url` under ESM and `__dirname` under CommonJS --
 * each is a syntax error in the other format -- and the two builds sit at
 * different depths below the package root, so even the relative path differs.
 * A stamped literal is identical in both, needs no file read at startup, and
 * keeps this package at zero runtime dependencies.
 *
 * The type is annotated `string` rather than left as the literal type so the
 * emitted .d.ts does not carry its own copy of the placeholder.
 */
export const VERSION: string = "0.0.0-unstamped";
