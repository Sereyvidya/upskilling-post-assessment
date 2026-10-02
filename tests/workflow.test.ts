import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { salonWorkflow } from "../src/workflows";
import { applyCommand, initialState } from "../src/model";
import type { Command, CommandResult, Opening, Offer, SalonState } from "../src/types";

type Handle = WorkflowHandle<typeof salonWorkflow>;
type CreateCommand = Extract<Command, { type: "create" }>;

// Every test uses real Temporal Workflow Updates, queries, and durable timers.
// A separate time-skipping server keeps tests independent of wall-clock delays.
async function withSalon(
  scenario: (handle: Handle, environment: TestWorkflowEnvironment) => Promise<void>,
): Promise<void> {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const taskQueue = `salon-test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("../src/workflows"),
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(salonWorkflow, {
        workflowId: taskQueue,
        taskQueue,
        args: [],
      });
      try {
        await scenario(handle, environment);
      } finally {
        await handle.cancel();
        // This coordinator is intentionally long-lived. Cancellation is cleanup.
        await handle.result().catch(() => undefined);
      }
    });
  } finally {
    await environment.teardown();
  }
}

function createOpening(id: string, overrides: Partial<CreateCommand> = {}): CreateCommand {
  return {
    type: "create",
    id,
    service: "Haircut",
    stylist: "Maya",
    duration: 30,
    startsAt: Date.now() + 60 * 60 * 1000,
    localTime: "16:00",
    mode: "standard",
    failDelivery: false,
    ...overrides,
  };
}

function send(handle: Handle, command: Command): Promise<CommandResult> {
  return handle.executeUpdate<CommandResult, [Command]>("command", { args: [command] });
}

function state(handle: Handle): Promise<SalonState> {
  return handle.query<SalonState>("salonState");
}

async function opening(handle: Handle, id: string): Promise<Opening> {
  const result = (await state(handle)).openings.find((item) => item.id === id);
  assert.ok(result, `Opening ${id} must be present`);
  return result;
}

function activeOffer(value: Opening): Offer {
  const offer = value.offers.find((item) => item.id === value.currentOfferId);
  assert.ok(offer, `Opening ${value.id} must have a current offer`);
  return offer;
}

test("FIFO matching respects service/stylist, with one 15-minute offer; questions do not reset it", async () => {
  await withSalon(async (handle) => {
    assert.equal((await send(handle, createOpening("fifo"))).ok, true);
    let slot = await opening(handle, "fifo");
    assert.deepEqual(slot.candidates, ["c1", "c2", "c3"]);
    const offer = activeOffer(slot);
    assert.equal(offer.clientId, "c1");
    assert.equal(offer.status, "pending");
    assert.equal(offer.deadline - offer.createdAt, 15 * 60 * 1000);
    assert.equal(slot.offers.filter((item) => item.status === "pending").length, 1);

    assert.equal((await send(handle, {
      type: "reply", openingId: slot.id, offerId: offer.id,
      response: "question", message: "Could I also get a fringe trim?",
    })).ok, true);
    slot = await opening(handle, "fifo");
    assert.equal(activeOffer(slot).id, offer.id);
    assert.equal(activeOffer(slot).deadline, offer.deadline);
    assert.equal(activeOffer(slot).question, "Could I also get a fringe trim?");
    assert.equal(slot.status, "offering");
  });
});

test("declines and durable expiry advance FIFO, and an expired offer cannot claim the slot", async () => {
  await withSalon(async (handle, environment) => {
    await send(handle, createOpening("expiry", { mode: "demo" }));
    const first = activeOffer(await opening(handle, "expiry"));
    assert.equal((await send(handle, {
      type: "reply", openingId: "expiry", offerId: first.id, response: "decline",
    })).ok, true);
    const second = activeOffer(await opening(handle, "expiry"));
    assert.equal(second.clientId, "c2");
    assert.notEqual(second.id, first.id);

    await environment.sleep("21 seconds");
    const slot = await opening(handle, "expiry");
    assert.equal(slot.offers.find((offer) => offer.id === first.id)?.status, "declined");
    assert.equal(slot.offers.find((offer) => offer.id === second.id)?.status, "expired");
    assert.equal(activeOffer(slot).clientId, "c3");
    assert.equal((await send(handle, {
      type: "reply", openingId: "expiry", offerId: second.id, response: "accept",
    })).ok, false);
    assert.equal((await opening(handle, "expiry")).winner, undefined);
  });
});

test("concurrent repeated accepts produce one winner, then staff confirms Square completion", async () => {
  await withSalon(async (handle) => {
    await send(handle, createOpening("accept"));
    const offer = activeOffer(await opening(handle, "accept"));
    const command: Command = {
      type: "reply", openingId: "accept", offerId: offer.id, response: "accept",
    };
    const results = await Promise.all([send(handle, command), send(handle, command)]);
    assert.ok(results.some((result) => result.ok));
    let slot = await opening(handle, "accept");
    assert.equal(slot.status, "accepted");
    assert.equal(slot.winner, "Amara");
    assert.equal(slot.offers.filter((item) => item.status === "accepted").length, 1);
    assert.equal(slot.offers.filter((item) => item.status === "pending").length, 0);
    assert.equal((await state(handle)).clients.find((client) => client.id === "c1")?.fulfilled, true);

    assert.equal((await send(handle, {
      type: "staff", openingId: "accept", action: "confirm",
    })).ok, true);
    slot = await opening(handle, "accept");
    assert.equal(slot.status, "filled");
    assert.equal(slot.winner, "Amara");
    assert.equal((await send(handle, {
      type: "reply", openingId: "accept", offerId: offer.id, response: "decline",
    })).ok, false);
    assert.equal((await opening(handle, "accept")).status, "filled");
  });
});

test("simultaneous openings cannot offer the same waitlist client or duplicate a stylist slot", async () => {
  await withSalon(async (handle) => {
    const start = Date.now() + 60 * 60 * 1000;
    await send(handle, createOpening("maya", { startsAt: start }));
    await send(handle, createOpening("jo", { startsAt: start, stylist: "Jo" }));
    assert.equal(activeOffer(await opening(handle, "maya")).clientId, "c1");
    assert.equal(activeOffer(await opening(handle, "jo")).clientId, "c3");

    const conflict = await send(handle, createOpening("overlap", {
      startsAt: start + 10 * 60 * 1000, localTime: "16:10",
    }));
    assert.equal(conflict.ok, false);
    const all = await state(handle);
    const pendingClients = all.openings.flatMap((slot) =>
      slot.offers.filter((offer) => offer.status === "pending").map((offer) => offer.clientId),
    );
    assert.equal(new Set(pendingClients).size, pendingClients.length);
  });
});

test("failed delivery pauses the queue; retry resends and skip advances without booking", async () => {
  await withSalon(async (handle, environment) => {
    await send(handle, createOpening("delivery", { mode: "demo", failDelivery: true }));
    let slot = await opening(handle, "delivery");
    assert.equal(slot.status, "attention");
    assert.equal(activeOffer(slot).status, "failed");
    assert.equal(activeOffer(slot).clientId, "c1");
    assert.ok((await state(handle)).notifications.some((notice) =>
      notice.openingId === slot.id && notice.outcome === "failed" && notice.simulated,
    ));

    await environment.sleep("21 seconds");
    slot = await opening(handle, "delivery");
    assert.equal(slot.status, "attention");
    assert.equal(activeOffer(slot).clientId, "c1");
    const failed = activeOffer(slot);
    assert.equal((await send(handle, {
      type: "staff", openingId: "delivery", action: "retry",
    })).ok, true);
    slot = await opening(handle, "delivery");
    assert.equal(slot.status, "offering");
    assert.equal(activeOffer(slot).status, "pending");
    assert.equal(activeOffer(slot).clientId, "c1");
    assert.notEqual(activeOffer(slot).id, failed.id);
    assert.ok(activeOffer(slot).deadline > failed.deadline);
    assert.equal((await send(handle, {
      type: "reply", openingId: "delivery", offerId: failed.id, response: "accept",
    })).ok, false);

    await send(handle, { type: "staff", openingId: "delivery", action: "cancel" });
    await send(handle, createOpening("skip-delivery", { failDelivery: true }));

    assert.equal((await send(handle, {
      type: "staff", openingId: "skip-delivery", action: "skip", reason: "No working phone number",
    })).ok, true);
    slot = await opening(handle, "skip-delivery");
    assert.equal(activeOffer(slot).clientId, "c2");
    assert.equal(slot.winner, undefined);
  });
});

test("acceptance at the exact deadline is rejected, with no booking or extra grace period", () => {
  // Supply exact logical times so this boundary cannot depend on RPC scheduling.
  const salon = initialState();
  const now = Date.now();
  applyCommand(salon, createOpening("boundary", { startsAt: now + 3_600_000 }), now);
  const offer = activeOffer(salon.openings[0]);
  const result = applyCommand(salon, {
    type: "reply", openingId: "boundary", offerId: offer.id, response: "accept",
  }, offer.deadline);
  assert.equal(result.ok, false);
  assert.equal(salon.openings[0].winner, undefined);
  assert.equal(offer.status, "expired");
  assert.equal(activeOffer(salon.openings[0]).clientId, "c2");
});

test("appointment time stops a delivery-failed search but preserves a confirmed booking", async () => {
  await withSalon(async (handle, environment) => {
    const startsAt = Date.now() + 30_000;
    await send(handle, createOpening("failed-start", { startsAt, failDelivery: true }));
    await send(handle, createOpening("confirmed-start", { startsAt, stylist: "Jo" }));
    const offer = activeOffer(await opening(handle, "confirmed-start"));
    await send(handle, {
      type: "reply", openingId: "confirmed-start", offerId: offer.id, response: "accept",
    });
    await send(handle, { type: "staff", openingId: "confirmed-start", action: "confirm" });
    await environment.sleep("31 seconds");
    assert.equal((await opening(handle, "failed-start")).status, "unfilled");
    assert.equal((await opening(handle, "confirmed-start")).status, "filled");
    assert.equal((await send(handle, {
      type: "staff", openingId: "failed-start", action: "retry",
    })).ok, false);
  });
});

test("cancellation and phone booking invalidate outstanding offers and stop later advancement", async () => {
  await withSalon(async (handle, environment) => {
    await send(handle, createOpening("cancel", { mode: "demo" }));
    const cancelledOffer = activeOffer(await opening(handle, "cancel"));
    assert.equal((await send(handle, {
      type: "staff", openingId: "cancel", action: "cancel", reason: "Stylist unavailable",
    })).ok, true);
    assert.equal((await opening(handle, "cancel")).status, "cancelled");
    assert.equal((await send(handle, {
      type: "reply", openingId: "cancel", offerId: cancelledOffer.id, response: "accept",
    })).ok, false);

    await send(handle, createOpening("phone", { mode: "demo" }));
    const phoneOffer = activeOffer(await opening(handle, "phone"));
    assert.equal((await send(handle, {
      type: "staff", openingId: "phone", action: "phone", reason: "Front desk booked by phone",
    })).ok, true);
    assert.equal((await opening(handle, "phone")).status, "filled");
    assert.equal((await send(handle, {
      type: "reply", openingId: "phone", offerId: phoneOffer.id, response: "accept",
    })).ok, false);

    await environment.sleep("21 seconds");
    const all = await state(handle);
    for (const slot of all.openings) {
      assert.equal(slot.offers.filter((offer) => offer.status === "pending").length, 0);
    }
    assert.equal((await opening(handle, "cancel")).offers.length, 1);
    assert.equal((await opening(handle, "phone")).offers.length, 1);
  });
});

test("STOP opts the client out of this queue and all future openings", async () => {
  await withSalon(async (handle) => {
    await send(handle, createOpening("stop"));
    const first = activeOffer(await opening(handle, "stop"));
    assert.equal((await send(handle, {
      type: "reply", openingId: "stop", offerId: first.id, response: "stop",
    })).ok, true);
    assert.equal((await state(handle)).clients.find((client) => client.id === "c1")?.optedOut, true);
    assert.equal(activeOffer(await opening(handle, "stop")).clientId, "c2");

    await send(handle, {
      type: "staff", openingId: "stop", action: "cancel", reason: "Opening removed",
    });
    await send(handle, createOpening("future"));
    const future = await opening(handle, "future");
    assert.equal(future.candidates.includes("c1"), false);
    assert.equal(activeOffer(future).clientId, "c2");
  });
});

test("unsuitable duration or availability exhausts safely without sending an offer", async () => {
  await withSalon(async (handle) => {
    await send(handle, createOpening("short-color", {
      service: "Color", stylist: "Jo", duration: 30,
    }));
    const short = await opening(handle, "short-color");
    assert.equal(short.status, "unfilled");
    assert.deepEqual(short.candidates, []);
    assert.deepEqual(short.offers, []);

    await send(handle, createOpening("too-late", {
      startsAt: Date.now() + 3 * 60 * 60 * 1000, localTime: "20:30",
    }));
    const late = await opening(handle, "too-late");
    assert.equal(late.status, "unfilled");
    assert.deepEqual(late.offers, []);
  });
});
