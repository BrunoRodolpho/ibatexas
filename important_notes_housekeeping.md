# Important Notes — Housekeeping

> Running notes for the `feat/housekeeping` branch.
> First topic: a full **IbateXas Admin app UI/UX + architecture overhaul** (needs the design skill).

## TODO — Admin Page Overhaul

**Overarching goal:** review the whole Admin app with the design skill and *ultrathink* a more advanced UI/UX.

- The left menu is **too wide** and mixes too many kinds of operations/options.
- Separate **day-to-day normal operations** (fast, easy access) from surfaces that need **deeper analysis / troubleshooting / immediate attention**, using **different levels of visibility and attention**.

---

### Item 1 — Global nav + information architecture
- Left menu is too wide; too many mixed operations crammed together.
- *Ultrathink* a more advanced UI/UX: everyday ops easy to reach; deep-analysis / troubleshooting / attention-needing items separated, each with a distinct level of visibility and attention.

### Item 2 — Incidents: missing client context
- In Incidents there is no way to see additional client info: **name, phone number, whether there is an order in progress**, and a **link to the client's full information**.
- *Ultrathink* how to surface client context + deep-links from an incident.

### Item 3 — Painel Operacional: quick links + time framing
- Needs *ultralinks* / quick links and more information: **date, today, week, month**.
- *Ultrathink* what else would help.
- Must **not conflict** with the Principal Dashboard — decide the division of responsibility between **Dashboard** and **Painel Operacional** (e.g. remove "Caixa hoje" from one of them). Tied to Item 7.

### Item 4 — Canal Operacional: unclear, needs full redesign
- The purpose of this UI is not understood. Needs an **entire *ultrathink* redesign**, starting from "what is it even for?".

### Item 5 — Escalações (take-over): transcript 404 + context
- Clicking an escalation throws `API error: 404 Not Found` from `src/lib/api.ts:28` (`apiFetch`), via `EscalacoesPage` `loadTranscript` at `src/app/admin/escalacoes/page.tsx:66`.
- **Fix the 404.**
- Each escalation should have a **UI summarization** + quick links to get context about it. *Ultrathink*.

### Item 6 — Conversas: filters, grid, pagination
- Need more filters: **date, search by order id**.
- UI/UX enhancement: **more brief details in the grid, pagination, quick links**.
- *Ultrathink* the design.

### Item 7 — Análises vs Painel Operacional vs Dashboard: consolidation
- Understand **what each page holds** and why they are separate.
- Consider a single nice page with good **navigation + expand/collapse** instead of three. *Ultrathink*. (Tied to Item 3.)

### Item 8 — Broadcast / Disparo em massa (WhatsApp)
- Recipients (Destinatários) should **not be free text** — needs **add / remove / edit** and a **rich UI**.
- Should support **filtering/queries**, e.g. "all customers from last month" and other queries.
- Idea: a small **AI chat** where the operator describes the audience in text and the AI queries customers to fill the recipient list. *Ultrathink*.
- **"Registrar opt-out"** — what does it mean? Needs an explanation in the UI.
- **"Recipientes que optaram por não receber"** should be filtered out. Open questions: are we **saving opt-out in the DB**? Are we **actually validating/enforcing** it here?

### Item 9 — Funcionários: permission hierarchy
- **Who can edit whom?** Who can **grant roles** to whom? Who can **see all the information**?
- **Where does this hierarchy come from and who manages it?**

### Item 10 — Clientes: PII visibility + client summary
- Question: can **everyone see all client info**? What do we suggest (access control)?
- Clientes UI: add a way to see a **summary of a client** — last order, link to orders, link to conversations. *Ultrathink*.

---

*Next step: read-only deep-dive of the admin codebase → per-item open questions + assumptions → then the detailed upgrade plan.*
