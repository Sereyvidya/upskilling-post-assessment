export type Client = { id: string; name: string; service: 'Haircut' | 'Color'; duration: number; stylist: 'Maya' | 'Jo' | 'Any'; availableFrom: string; availableTo: string; joined: number; optedOut: boolean; fulfilled: boolean };
export type Offer = { id: string; clientId: string; clientName: string; deadline: number; createdAt: number; status: 'pending' | 'failed' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'skipped'; question?: string };
export type Opening = { id: string; service: 'Haircut' | 'Color'; stylist: 'Maya' | 'Jo'; duration: number; startsAt: number; localTime: string; mode: 'demo' | 'standard'; status: 'offering' | 'attention' | 'accepted' | 'filled' | 'unfilled' | 'cancelled'; candidates: string[]; offers: Offer[]; currentOfferId?: string; winner?: string; failureNext: boolean; createdAt: number; history: { at: number; message: string }[]; terminalReason?: string };
export type Notice = { id: string; at: number; openingId: string; audience: string; message: string; simulated: true; outcome: 'sent' | 'failed' };
export type SalonState = { clients: Client[]; openings: Opening[]; notifications: Notice[]; version: number };
export type Command =
 | { type: 'create'; id: string; service: 'Haircut' | 'Color'; stylist: 'Maya' | 'Jo'; duration: number; startsAt: number; localTime: string; mode: 'demo' | 'standard'; failDelivery: boolean }
 | { type: 'reply'; openingId: string; offerId: string; response: 'accept' | 'decline' | 'question' | 'stop'; message?: string }
 | { type: 'staff'; openingId: string; action: 'retry' | 'skip' | 'cancel' | 'phone' | 'confirm'; reason?: string };
export type CommandResult = { ok: boolean; message: string; openingId?: string };
