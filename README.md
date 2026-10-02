# Juniper Salon — same-day waitlist prototype

Juniper fills cancelled appointments through one exclusive offer at a time. Staff create an opening, and a durable Temporal workflow selects an eligible client, tracks the offer's deadline, and advances after a decline or timeout. An acceptance holds the opening until staff update Square and confirm it here.

This is a **local assessment prototype using fictional clients and simulated messages**. It sends no SMS, changes no Square bookings, and has no authentication. Staff and client controls appear together so the complete process can be demonstrated on one laptop.

## Run locally

Requirements: Node.js 20 or newer, npm, and Docker Desktop running. From the repository root:

```bash
npm ci && npm run dev
```

Open [the salon dashboard](http://localhost:3000) and [Temporal Web](http://localhost:8233). The development command starts the local Temporal service, Worker, and API. Ports 3000, 7233, and 8233 must be available. The first Docker image download can take a few minutes.

```bash
npm test          # Workflow behavior tests
npm run typecheck # TypeScript checks
```

The automated suite contains 10 checks: nine Temporal integration tests and one exact-deadline state-transition test. It covers timeout/decline progression, acceptance races, stale and repeated replies, questions, delivery failure, opt-out, staff intervention and appointment-start behavior. Browser reload, stale-offer rejection, acceptance/Square handoff, failed-delivery retry, phone booking and an actual API/Worker restart were also checked locally. See [saved evidence](evidence/README.md) for screenshots and the recovery snapshots. Passing these checks does not prove a production deployment is ready.

Press Control+C in the development terminal to stop the API and Worker. `npm run stop` stops the local Temporal container; its named Docker volume retains history. Do not delete that volume if you want to preserve the demonstration's state.

## Demonstrate the customer workflow

Use **Add an opening → Start inviting** to choose an opening later today with enough remaining time for the demonstration and matching fictional waitlist clients. Eligibility uses service, duration, stylist preference, and availability. Client order comes from waitlist arrival order.

**Standard mode uses Lena's 15-minute offer policy. Demo mode uses 20 seconds**, explicitly labelled in the interface. Accelerated demo timing is for review and testing only.

1. **Automatic progression.** Create an eligible opening in Demo mode. Leave the first offer unanswered and wait longer than 20 seconds. It expires and the next eligible client receives a new exclusive offer. The event history records the transition. Declining an offer advances immediately; it does not remove the client from future openings.
2. **Acceptance and Square handoff.** Under **Simulated client**, choose the current offer and click **Accept offer**. The opening is held for that client and awaits staff confirmation. Inspect the simulated client/front-desk notifications. After pretending to update Square, click **Mark updated in Square**. Any existing later appointment must also be moved manually in Square.
3. **Stale reply protection.** Let an offer expire or supersede it with a staff phone booking. Under **Simulated client → Reply to an offer**, select that historical offer, labelled Expired or Cancelled, then click **Accept offer**. The API must reject it; it cannot replace the current winner. Repeating an accepted response cannot create another booking.
4. **Questions.** Under **Other client responses**, use **Send question** for the current client. It raises staff attention without confirming a booking or extending the original deadline. Staff can see the question and decide how to assist.
5. **Failed delivery.** Create an opening with **Simulate a delivery failure on the first offer** checked. The search pauses visibly; no confirmed delivery or booking is claimed. Exercise **Retry delivery**, **Skip client**, and **Stop search** on separate examples. Retry creates a new offer identity and a new deadline for the same client; the failed offer cannot be accepted. Failure does not silently advance the queue.
6. **Staff intervention.** Use **Record phone booking** while an offer is pending, then attempt to accept the old offer. Use **Stop search** on a separate opening when it is no longer available. Neither old offer may subsequently claim the opening.
7. **Opt-out.** Use **Reply STOP · Leave the waitlist** for a client. The client is excluded from future offers. This is different from declining one particular appointment.
8. **Page recovery.** Create an offer, note its original deadline, and reload or close/reopen the page. The dashboard reconstructs the current workflow state; reloading does not start a new timer.
9. **Worker recovery.** Create an offer and note its deadline. Stop the development terminal with Control+C, leave Temporal running, wait past the deadline, then restart with `npm run dev`. The workflow recovers from its history and processes the overdue expiry. The API and Worker need to be running again before the dashboard can serve updates; this does not demonstrate high availability during an outage.

Exhausting all candidates leaves the opening unfilled and notifies staff. An unfilled search also stops when the appointment starts. There is no invented travel-time cutoff: staff can stop an opening earlier if necessary.

## Requirements and implementation

The source of the rules is [DISCOVERY.txt](DISCOVERY.txt), summarizing the assigned assessment scenario. The raw customer conversation is kept locally under `evidence/discovery/` and excluded from the public repository. Lena changed her initial broadcast preference to exclusive offers after discussing two clients expecting the same appointment. The implementation follows that final decision.

| Customer requirement | Prototype behavior / evidence to inspect |
| --- | --- |
| Fair, relevant offers | FIFO selection among clients whose service, duration, stylist and availability fit |
| One exclusive 15-minute offer | Original deadline shown; automatic decline/expiry progression; separate 20-second demo mode |
| No double booking | Serialized workflow commands validate offer identity, status and deadline before acceptance |
| Questions do not reserve a slot | Staff-attention marker; original deadline retained |
| Delivery failure needs a decision | Paused state with explicit staff retry, skip or stop |
| STOP applies to future offers | Opt-out stored in durable client state |
| Cancelled opening / phone booking | Outstanding offer cancelled; late replies cannot claim it |
| Acceptance still needs Square work | Held/awaiting-confirmation state and explicit staff confirmation |
| Staff can leave the page | Temporal history and timers retain state independently of the browser |
| Staff understand the outcome | Offer history, remaining candidates, notifications and final status |

`src/model.ts` implements the business transitions; `src/workflows.ts` runs them in `salonWorkflow` with durable timers. `src/api.ts` exposes Temporal queries and updates, `src/worker.ts` runs the Worker, and `src/types.ts` defines the shared contract. The browser interface is in `public/`, and workflow tests are in `tests/`. The workflow ID in Temporal Web is `juniper-salon-v1`.

This prototype uses **one durable salon workflow** for the waitlist, openings, offers and notifications. Commands are serialized in that workflow, so two callers cannot independently award the same opening. Temporal persists its history; there is no separate application database and no browser-local source of truth. The discovery handoff originally suggested one workflow per opening. Centralizing the small salon's state is an implementation choice for this prototype, not a requirement attributed to Lena.

The concurrency policy is a prototype assumption: a client receives at most one active offer across openings, and acceptance marks that client fulfilled for this waitlist. A client busy with another opening can be skipped; a search that becomes unfilled is not automatically reopened when that client becomes free. Staff cannot create overlapping active openings/bookings for the same stylist. Phone bookings currently store the name supplied by staff rather than linking to a waitlist identity.

Notification records marked as sent are **successful simulated delivery events**, not messages sent to actual phones. Real delivery would need an external provider, durable activity execution, delivery callbacks and idempotency controls.

## Scope and limits

- Local laptop demonstration only. No public deployment, login, access control or real client information. The displayed roles are labels, not authorization boundaries.
- Manual same-day openings and a seeded fictional waitlist of six clients. The initial fixture is stored when the salon workflow first starts; restarting the application does not reset those clients or erase opt-outs and bookings. No Square/calendar import, real consent management, client editing or automatic appointment rescheduling.
- The local browser and API host represent the salon's timezone for this demonstration. The API validates that the appointment is later today according to the host's local date and that the submitted clock time matches it. This is not multi-timezone scheduling; production use needs an explicit salon timezone and broader scheduling validation.
- One salon and one long-lived workflow keep this demonstration small. There is no production scaling, workflow-history rollover, deployment-versioning or operational alerting plan implemented here.
- Concurrent-opening behavior follows the assumptions above, including no automatic restart of an exhausted search. These choices require confirmation before real scheduling.
- A successful test or demo does not establish a real fill-rate improvement. Lena's estimate of 8–12 cancellations within 48 hours per week is not a measured same-day baseline. A future trial should measure same-day fill rate and staff time spent chasing replies.

## Provenance

This application extends the supplied Temporal assessment starter. AI assistance was used for customer discovery, implementation, tests and documentation. Discovery evidence is saved separately from setup evidence so the neutral starter demonstration is not presented as the completed customer prototype. Recordings and activity logs remain separate assessment artifacts; this README does not assert an independently verified assessment start time.
