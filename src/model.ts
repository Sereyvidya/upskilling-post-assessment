import type { Client, Command, CommandResult, Notice, Offer, Opening, SalonState } from './types';

export function initialState(): SalonState {
  const people: [string, string, Client['service'], number, Client['stylist']][] = [
    ['c1', 'Amara', 'Haircut', 30, 'Any'], ['c2', 'Ben', 'Haircut', 30, 'Maya'],
    ['c3', 'Cleo', 'Haircut', 30, 'Any'], ['c4', 'Dev', 'Color', 60, 'Jo'],
    ['c5', 'Eva', 'Color', 60, 'Any'], ['c6', 'Finn', 'Haircut', 30, 'Jo'],
  ];
  return { clients: people.map(([id, name, service, duration, stylist], joined) => ({ id, name, service, duration, stylist, joined, availableFrom: '09:00', availableTo: '20:00', optedOut: false, fulfilled: false })), openings: [], notifications: [], version: 0 };
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const active = (o: Opening) => o.status === 'offering' || o.status === 'attention';
function log(o: Opening, now: number, message: string): void { o.history.push({ at: now, message }); }
function notice(s: SalonState, o: Opening, now: number, audience: string, message: string, outcome: Notice['outcome'] = 'sent'): void {
  s.notifications.push({ id: `${o.id}-n${s.notifications.length + 1}`, at: now, openingId: o.id, audience, message, simulated: true, outcome });
}
function current(o: Opening): Offer | undefined { return o.offers.find(x => x.id === o.currentOfferId); }
function stop(s: SalonState, o: Opening, now: number, status: Opening['status'], reason: string): void {
  const offer = current(o);
  if (offer && (offer.status === 'pending' || offer.status === 'failed')) {
    offer.status = 'cancelled';
    notice(s, o, now, offer.clientName, `This opening is no longer available: ${reason}`);
  }
  o.currentOfferId = undefined;
  o.status = status;
  o.terminalReason = reason;
  log(o, now, reason);
  notice(s, o, now, 'Front desk', reason);
}
function sendOffer(s: SalonState, o: Opening, client: Client, now: number): void {
  const failed = o.failureNext;
  o.failureNext = false;
  const offer: Offer = { id: `${o.id}-offer-${o.offers.length + 1}`, clientId: client.id, clientName: client.name, createdAt: now, deadline: Math.min(now + (o.mode === 'demo' ? 20_000 : 900_000), o.startsAt), status: failed ? 'failed' : 'pending' };
  o.offers.push(offer);
  o.currentOfferId = offer.id;
  o.status = failed ? 'attention' : 'offering';
  if (failed) {
    log(o, now, `Delivery to ${client.name} failed. Staff must retry, skip, or stop.`);
    notice(s, o, now, client.name, 'Offer could not be delivered; no confirmed reservation.', 'failed');
    notice(s, o, now, 'Front desk', 'Delivery failed. Search paused; no offer has been confirmed.');
  } else {
    log(o, now, `Exclusive offer sent to ${client.name}.`);
    notice(s, o, now, client.name, `${o.service} with ${o.stylist} at ${new Date(o.startsAt).toISOString()}. Please explicitly accept before ${new Date(offer.deadline).toISOString()}. ${o.mode === 'demo' ? 'DEMO: 20-second response window.' : '15-minute response window, capped at appointment start.'}`);
  }
}
function advance(s: SalonState, o: Opening, now: number): void {
  if (now >= o.startsAt) { stop(s, o, now, 'unfilled', 'Appointment time arrived; search ended.'); return; }
  const candidate = o.candidates.map(id => s.clients.find(c => c.id === id)!).find(c =>
    !c.optedOut && !c.fulfilled && !o.offers.some(f => f.clientId === c.id) &&
    !s.openings.some(other => other.id !== o.id && (active(other) || other.status === 'accepted') && current(other)?.clientId === c.id));
  if (!candidate) { stop(s, o, now, 'unfilled', 'No remaining eligible clients. Opening is unfilled.'); return; }
  sendOffer(s, o, candidate, now);
}

export function expireDue(s: SalonState, now: number): void {
  for (const o of s.openings) {
    if (!active(o)) continue;
    if (now >= o.startsAt) { stop(s, o, now, 'unfilled', 'Appointment time arrived; search ended.'); s.version++; continue; }
    const offer = current(o);
    if (o.status === 'offering' && offer?.status === 'pending' && now >= offer.deadline) {
      offer.status = 'expired';
      log(o, now, `${offer.clientName}'s offer expired without acceptance.`);
      notice(s, o, now, offer.clientName, 'Your offer expired. You remain on the waitlist for future openings.');
      advance(s, o, now);
      s.version++;
    }
  }
}

export function nextDeadline(s: SalonState): number | undefined {
  const values = s.openings.filter(active).flatMap(o => {
    const f = current(o);
    return o.status === 'offering' && f?.status === 'pending' ? [o.startsAt, f.deadline] : [o.startsAt];
  });
  return values.length ? Math.min(...values) : undefined;
}

export function applyCommand(s: SalonState, cmd: Command, now: number): CommandResult {
  expireDue(s, now);
  s.version++;
  const result = (ok: boolean, message: string, openingId?: string): CommandResult => ({ ok, message, openingId });
  if (cmd.type === 'create') {
    if (s.openings.some(o => o.id === cmd.id)) return result(true, 'This opening already exists.', cmd.id);
    if (cmd.startsAt <= now) return result(false, 'Choose an appointment in the future.');
    if (s.openings.some(o => o.stylist === cmd.stylist && !['cancelled', 'unfilled'].includes(o.status) && cmd.startsAt < o.startsAt + o.duration * 60_000 && o.startsAt < cmd.startsAt + cmd.duration * 60_000)) return result(false, 'This stylist already has an overlapping opening or booking.');
    const candidates = s.clients.filter(c => !c.optedOut && !c.fulfilled && c.service === cmd.service && c.duration <= cmd.duration && (c.stylist === 'Any' || c.stylist === cmd.stylist) && minutes(cmd.localTime) >= minutes(c.availableFrom) && minutes(cmd.localTime) + c.duration <= minutes(c.availableTo)).sort((a, b) => a.joined - b.joined).map(c => c.id);
    const o: Opening = { ...cmd, status: 'offering', candidates, offers: [], failureNext: cmd.failDelivery, createdAt: now, history: [] };
    s.openings.push(o);
    log(o, now, `${cmd.mode === 'demo' ? 'Accelerated demo (20 seconds)' : 'Standard (15 minutes)'} search created. ${candidates.length} eligible clients.`);
    advance(s, o, now);
    return result(true, 'Opening created. All messages are simulated.', o.id);
  }
  const o = s.openings.find(item => item.id === cmd.openingId);
  if (!o) return result(false, 'Opening not found.');
  if (cmd.type === 'reply') {
    const f = o.offers.find(item => item.id === cmd.offerId);
    if (!f) return result(false, 'Offer not found.', o.id);
    const client = s.clients.find(c => c.id === f.clientId)!;
    if (cmd.response === 'stop') {
      client.optedOut = true;
      notice(s, o, now, client.name, 'You are opted out of future offers. Existing accepted bookings are unchanged.');
      for (const open of s.openings) if (active(open) && current(open)?.clientId === client.id) {
        current(open)!.status = 'declined'; log(open, now, `${client.name} opted out.`); advance(s, open, now);
      }
      return result(true, 'Client removed from all future offers.', o.id);
    }
    if (cmd.response === 'accept' && f.status === 'accepted' && (o.status === 'accepted' || o.status === 'filled')) return result(true, 'This acceptance was already recorded; no second booking was made.', o.id);
    if (o.status !== 'offering' || o.currentOfferId !== f.id || f.status !== 'pending' || now >= f.deadline || client.optedOut || client.fulfilled) {
      log(o, now, `Rejected ${cmd.response} for an inactive offer from ${client.name}.`);
      notice(s, o, now, client.name, 'This offer is no longer available and cannot be accepted. Please contact the front desk.');
      notice(s, o, now, 'Front desk', `Late or inactive reply rejected for ${client.name}. No booking changed.`);
      return result(false, 'Offer expired, was canceled, or is no longer current. No booking changed.', o.id);
    }
    if (cmd.response === 'question') {
      f.question = cmd.message?.trim() || 'Client requests clarification.';
      log(o, now, `${client.name} asked: ${f.question}. Original deadline unchanged.`);
      notice(s, o, now, 'Front desk', `${client.name} needs help: ${f.question}. Reply deadline still applies.`);
      return result(true, 'Question flagged for staff; the deadline has not changed.', o.id);
    }
    if (cmd.response === 'decline') {
      f.status = 'declined'; log(o, now, `${client.name} declined; remains eligible for future openings.`); advance(s, o, now);
      return result(true, 'Declined. Search advanced.', o.id);
    }
    f.status = 'accepted'; o.status = 'accepted'; o.winner = client.name; client.fulfilled = true;
    log(o, now, `${client.name} accepted. Opening held; awaiting staff Square update.`);
    notice(s, o, now, client.name, `The ${o.service} opening with ${o.stylist} at ${new Date(o.startsAt).toISOString()} is held for you, awaiting front-desk calendar confirmation.`);
    notice(s, o, now, 'Front desk', `${client.name} accepted. Update Square and then confirm; move any later appointment manually.`);
    return result(true, 'Acceptance recorded. Staff must update Square before final confirmation.', o.id);
  }
  if (cmd.action === 'confirm') {
    if (o.status !== 'accepted') return result(false, 'Only an accepted opening can be confirmed.', o.id);
    o.status = 'filled'; log(o, now, 'Staff confirmed the manual Square update.');
    notice(s, o, now, o.winner!, `Confirmed: ${o.service} with ${o.stylist} at ${new Date(o.startsAt).toISOString()}.`);
    notice(s, o, now, 'Front desk', 'Opening filled and calendar update confirmed.');
    return result(true, 'Calendar update recorded; opening filled.', o.id);
  }
  if (cmd.action === 'cancel' && (active(o) || o.status === 'accepted')) {
    const f = current(o);
    if (o.status === 'accepted' && f) {
      s.clients.find(c => c.id === f.clientId)!.fulfilled = false;
      f.status = 'cancelled';
      notice(s, o, now, f.clientName, `Your held opening was cancelled: ${cmd.reason || 'Staff cancelled'}. Please contact the front desk.`);
    }
    stop(s, o, now, 'cancelled', cmd.reason?.trim() || 'Staff cancelled this opening.');
    return result(true, 'Opening cancelled. Outstanding offers are invalid.', o.id);
  }
  if (!active(o)) return result(false, 'This opening is no longer accepting staff search actions.', o.id);
  if (cmd.action === 'phone') {
    if (!cmd.reason?.trim()) return result(false, 'Enter the name used for the phone booking.', o.id);
    o.winner = cmd.reason.trim();
    stop(s, o, now, 'filled', `Filled by phone for ${o.winner}; staff attest that Square is updated.`);
    notice(s, o, now, o.winner, `Phone booking confirmed: ${o.service} with ${o.stylist} at ${new Date(o.startsAt).toISOString()}.`);
    return result(true, 'Phone booking recorded; old offers cannot claim the slot.', o.id);
  }
  if (cmd.action === 'retry' && o.status === 'attention') {
    const f = current(o)!;
    f.status = 'cancelled'; log(o, now, 'Staff retried failed delivery. A new offer and deadline were created.');
    sendOffer(s, o, s.clients.find(c => c.id === f.clientId)!, now);
    return result(true, 'Retry delivered in simulation. New response deadline started.', o.id);
  }
  if (cmd.action === 'skip' && o.status === 'attention') {
    current(o)!.status = 'skipped'; log(o, now, 'Staff skipped the failed delivery.'); advance(s, o, now);
    return result(true, 'Skipped; moved to the next eligible client.', o.id);
  }
  return result(false, 'That action is not available in the current state.', o.id);
}
