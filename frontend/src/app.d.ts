// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** Injected by vite.config.ts from package.json — the pre-alpha banner. */
	const __APP_VERSION__: string;
	/** Injected by vite.config.ts — the version this build was made from. */
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
