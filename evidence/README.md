# Prototype evidence

Captured locally on October 2, 2026. All salon clients and messages are fictional/simulated.

- `dashboard.png`: completed salon interface, including an active search and two staff-confirmed openings.
- `dashboard-offer.png`: offer and simulated-client controls.
- `temporal-workflow.png`: representative workflow identity and RUNNING status.
- `temporal-history.png`: event history of that same workflow, including a 15-minute durable timer and completed commands. Read together with the identity screenshot.
- `verification/VALIDATION.txt`: checks actually performed and their limits.
- `verification/recovery-before.json` and `recovery-after.json`: original offer deadline retained across an API/Worker restart; expiry subsequently advanced to the next client and exhausted the queue.
- Local-only `discovery/customer-chat.txt` and `discovery/lena-confirmation.png`: raw customer discovery and scope confirmation, excluded from the public repository. The public requirements summary is `../DISCOVERY.txt`.
- `setup/`: earlier neutral starter verification, separate from prototype evidence.

The representative workflow is `juniper-salon-v1`, run `01a0feb4-b308-7745-85e5-4176410761a9`. It intentionally remains RUNNING because it holds the salon's ongoing waitlist; individual openings reach filled, cancelled or unfilled states inside it. A RUNNING status is not an unfinished individual booking.

The five-slide [Juniper Salon presentation](../Juniper-Salon-Presentation.pdf) is included at the repository root alongside the prototype and evidence.
