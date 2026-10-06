// `ibx dev stop -f` could never kill the ngrok tunnel, and nothing pinned that.
//
// Two independent causes, both silent: `-f` returns from `pcStop` BEFORE the
// graceful `process-compose down`, so the `tunnel` process's own
// `shutdown: {signal: 15}` never fires; and the port sweep that stands in for it
// was built purely from SERVICES + :8080, none of which ngrok holds — the agent
// is an outbound client, the api owns :3001, and ngrok's only listener is its
// inspector on :4040. `-f` then SIGKILLs process-compose itself, so the agent
// reparents to pid 1 and keeps holding the account's reserved domain; the next
// `ibx dev` dies with ERR_NGROK_334 (observed: an agent orphaned for a full day)
// while `stop -f` had already printed "Done."
//
// Scope note: this pins the RESOLVED PORT SET only — which ports the force path
// targets. The argv-matching complement (`killNgrokTunnel`, for agents started
// with `--inspect=false`, which listen on nothing) is not covered here; it
// shells out to pgrep/pkill and has no pure seam.

import { describe, it, expect } from "vitest"
import { resolveForceStopPorts } from "../commands/dev.js"
import { SERVICES } from "../services.js"

const NGROK_INSPECTOR_PORT = 4040
const PROCESS_COMPOSE_PORT = 8080

describe("resolveForceStopPorts — stop-all", () => {
  it("sweeps ngrok's inspector port (the regression: the tunnel was unreachable)", () => {
    expect(resolveForceStopPorts(undefined, true, SERVICES)).toContain(NGROK_INSPECTOR_PORT)
  })

  it("still sweeps every SERVICES port and process-compose's own server", () => {
    const ports = resolveForceStopPorts(undefined, true, SERVICES)
    for (const svc of Object.values(SERVICES)) {
      expect(ports).toContain(svc.port)
    }
    expect(ports).toContain(PROCESS_COMPOSE_PORT)
  })

  it("does not sweep the api port as a stand-in for the tunnel", () => {
    // :3001 is swept because the API listens there. If ngrok coverage ever
    // regressed to "well, 3001 is in the list", this test says why that is not
    // the same thing — killing the api does not disturb the ngrok agent.
    expect(SERVICES.api.port).toBe(3001)
    expect(NGROK_INSPECTOR_PORT).not.toBe(SERVICES.api.port)
  })
})

describe("resolveForceStopPorts — named service", () => {
  it("`tunnel` resolves to the inspector port (it is not a SERVICES entry)", () => {
    // Before the fix this fell through the SERVICES lookup to [], so
    // `ibx dev stop tunnel -f` killed nothing and reported success.
    expect(resolveForceStopPorts("tunnel", false, SERVICES)).toEqual([NGROK_INSPECTOR_PORT])
  })

  it("an ordinary service takes ONLY its own port — never the tunnel", () => {
    // The control: stopping `web` must not sever WhatsApp webhook delivery.
    const ports = resolveForceStopPorts("web", false, SERVICES)
    expect(ports).toEqual([SERVICES.web.port])
    expect(ports).not.toContain(NGROK_INSPECTOR_PORT)
    expect(ports).not.toContain(PROCESS_COMPOSE_PORT)
  })

  it("an unknown key resolves to no ports at all", () => {
    expect(resolveForceStopPorts("nope", false, SERVICES)).toEqual([])
  })
})
