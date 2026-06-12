// clients/ barrel — SUT-facing clients (public surface only).
//
// T1a-4: authFixture — fingerprint-gated offline JWT minting + cookie
// transport (cookieHeader is shared with the ChatClient, T1a-5).
// T1a-5 (ChatClient) adds its export line here; agents edit ONLY this
// barrel — the root src/index.ts already re-exports it.

export * from "./auth-fixture.js"
