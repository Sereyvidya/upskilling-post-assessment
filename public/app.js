'use strict';

(() => {
  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const state = { data: null, filter: 'all', selectedOffer: '', fingerprint: '', busy: false, connected: false, staffAction: null, toastTimer: null };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const initials = name => String(name || '?').split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const exactTimeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const formatTime = value => timeFormat.format(new Date(value));
  const exactTime = value => exactTimeFormat.format(new Date(value));
  const localizeMessage = value => String(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, match => {
    const date = new Date(match);
    return Number.isNaN(date.getTime()) ? match : `${dateFormat.format(date)}, ${exactTime(date)}`;
  });
  const localDateTime = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const activeStatuses = new Set(['offering', 'attention']);
  const statusLabels = { offering: 'Inviting', attention: 'Needs a hand', accepted: 'Awaiting Square', filled: 'Square confirmed', unfilled: 'Unfilled', cancelled: 'Search stopped' };
  const offerStatusLabels = { pending: 'Current offer', failed: 'Delivery failed', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', cancelled: 'Cancelled', skipped: 'Skipped' };

  $('#today-label').textContent = `${new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()} · FRONT DESK`;

  function currentOffer(opening) {
    return opening.offers.find(offer => offer.id === opening.currentOfferId);
  }

  function clientName(id) {
    return state.data.clients.find(client => client.id === id)?.name || id || 'Phone client';
  }

  function remainingClients(opening) {
    const alreadyOffered = new Set(opening.offers.map(offer => offer.clientId));
    const invitedElsewhere = new Set(state.data.openings.filter(other => other.id !== opening.id && (activeStatuses.has(other.status) || other.status === 'accepted')).map(other => currentOffer(other)?.clientId).filter(Boolean));
    return opening.candidates
      .filter(id => !alreadyOffered.has(id))
      .map(id => state.data.clients.find(client => client.id === id))
      .filter(client => client && !client.optedOut && !client.fulfilled && !invitedElsewhere.has(client.id));
  }

  function setConnected(connected, message = '') {
    state.connected = connected;
    const indicator = $('#connection-status');
    indicator.classList.toggle('disconnected', !connected);
    indicator.innerHTML = `<span class="little-dot"></span>${connected ? 'Live updates' : 'Reconnecting'}`;
    const alert = $('#connection-alert');
    alert.hidden = connected;
    alert.textContent = message || 'The front desk connection is unavailable. Displayed information may be out of date. Reconnecting automatically…';
    updateReplyButtons();
  }

  async function refresh() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Unable to load the front desk.');
      if (!Array.isArray(data.openings) || !Array.isArray(data.clients) || !Array.isArray(data.notifications)) throw new Error('The salon state is not available yet.');
      state.data = data;
      setConnected(true);
      const fingerprint = JSON.stringify(data);
      if (fingerprint !== state.fingerprint) {
        state.fingerprint = fingerprint;
        render();
      }
      tick();
    } catch (error) {
      setConnected(false, state.data ? undefined : `Waiting for the salon service: ${error.message} Retrying automatically.`);
      if (!state.data) $('#opening-list').innerHTML = '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h3>The front desk is reconnecting.</h3><p>The service needs to be running before an invitation can be sent. We’ll keep trying.</p></div>';
    }
  }

  function toast(message, isError = false) {
    clearTimeout(state.toastTimer);
    $('#toast-region').innerHTML = `<div class="toast${isError ? ' error' : ''}">${escapeHTML(message)}</div>`;
    state.toastTimer = setTimeout(() => { $('#toast-region').innerHTML = ''; }, 5500);
  }

  async function command(payload) {
    if (state.busy) return null;
    state.busy = true;
    document.body.setAttribute('aria-busy', 'true');
    updateReplyButtons();
    $$('[data-staff], #create-button, #staff-submit').forEach(button => { button.disabled = true; });
    try {
      const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || 'That action could not be completed.');
      await refresh();
      return result;
    } finally {
      state.busy = false;
      document.body.removeAttribute('aria-busy');
      $$('[data-staff], #create-button, #staff-submit').forEach(button => { button.disabled = false; });
      updateReplyButtons();
    }
  }

  function render() {
    const { openings, clients, notifications } = state.data;
    $('#stat-active').textContent = openings.filter(opening => activeStatuses.has(opening.status)).length;
    $('#stat-reserved').textContent = openings.filter(opening => opening.status === 'accepted').length;
    $('#stat-filled').textContent = openings.filter(opening => opening.status === 'filled').length;
    $('#opening-count').textContent = openings.length;
    $('#attention-count').textContent = openings.filter(needsAttention).length;
    $('#client-count').textContent = `${clients.length} fictional clients`;
    renderOpenings();
    renderOffers();
    renderWaitlist(clients);
    renderMessages(notifications);
  }

  function needsAttention(opening) {
    return opening.status === 'attention' || opening.status === 'accepted' || Boolean(currentOffer(opening)?.question && activeStatuses.has(opening.status));
  }

  function renderOpenings() {
    const expanded = new Set($$('.card-history[open]').map(element => element.dataset.opening));
    const focus = document.activeElement;
    const focusKey = focus?.dataset.staff ? { opening: focus.dataset.opening, staff: focus.dataset.staff } : null;
    const openings = [...state.data.openings].sort((a, b) => b.createdAt - a.createdAt).filter(opening => {
      if (state.filter === 'active') return activeStatuses.has(opening.status);
      if (state.filter === 'attention') return needsAttention(opening);
      return true;
    });
    if (!openings.length) {
      $('#opening-list').innerHTML = state.data.openings.length
        ? '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✓</span><h3>Nothing to follow up here.</h3><p>Choose “All openings” to see the whole day.</p></div>'
        : '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">✳</span><h3>Let’s make someone’s day.</h3><p>A cancellation can become a welcome invitation. Add an opening and we’ll find the first eligible client.</p><button class="button button-secondary" type="button" data-new-opening>＋ Add your first opening</button></div>';
      return;
    }
    $('#opening-list').innerHTML = openings.map(opening => openingCard(opening, expanded.has(opening.id))).join('');
    if (focusKey) {
      const replacement = $$('[data-staff]').find(button => button.dataset.opening === focusKey.opening && button.dataset.staff === focusKey.staff);
      replacement?.focus({ preventScroll: true });
    }
    tick();
  }

  function openingCard(opening, expanded) {
    const offer = currentOffer(opening);
    const remaining = remainingClients(opening);
    const status = statusLabels[opening.status] || opening.status;
    const date = dateFormat.format(new Date(opening.startsAt));
    const history = [...opening.history].reverse();
    const id = escapeHTML(opening.id);
    const staffButton = (action, label, className = 'button button-text') => `<button class="${className}" type="button" data-staff="${action}" data-opening="${id}" ${state.busy ? 'disabled' : ''}>${label}</button>`;
    let body = '';
    if (opening.status === 'offering' && offer) {
      body = `<div class="offer-body"><div class="offer-top"><div class="offer-person"><span class="client-avatar" aria-hidden="true">${escapeHTML(initials(offer.clientName))}</span><div><strong>Waiting for ${escapeHTML(offer.clientName)}</strong><small>One exclusive invitation</small></div></div><span class="offer-window-label">${opening.mode === 'demo' ? '<span class="demo-tag">20-SECOND DEMO</span>' : '15-MINUTE OFFER'}</span></div><div class="countdown-row"><span>Time left to reply</span><strong data-deadline="${offer.deadline}">—</strong></div><div class="progress-track" role="progressbar" aria-label="Offer time remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" data-progress-deadline="${offer.deadline}" data-created="${offer.createdAt}"><div class="progress-fill"></div></div><p class="expiry-line">Original deadline: ${escapeHTML(exactTime(offer.deadline))} · next client is invited automatically</p>${offer.question ? `<div class="question-note"><strong>CLIENT QUESTION · NEEDS A HAND</strong>“${escapeHTML(offer.question)}”<small>Follow up with the client. The original deadline still applies; this is not an acceptance.</small></div>` : ''}</div>`;
    } else if (opening.status === 'attention') {
      body = `<div class="status-body warning"><h4><span class="status-icon" aria-hidden="true">!</span> Delivery failed. Search paused.</h4><p>${offer ? `The simulated invitation to ${escapeHTML(offer.clientName)} was not delivered. ` : ''}Choose what happens next. No booking is confirmed.</p><div class="inline-actions">${staffButton('retry', 'Retry delivery', 'button button-primary button-small')}${staffButton('skip', 'Skip client', 'button button-secondary button-small')}</div></div>`;
    } else if (opening.status === 'accepted') {
      body = `<div class="status-body success"><h4><span class="status-icon" aria-hidden="true">✓</span> Reserved for ${escapeHTML(clientName(opening.winner))}</h4><p>Update Square manually, including moving any existing later appointment. Then confirm the calendar is up to date here.</p>${staffButton('confirm', 'Mark updated in Square', 'button button-primary button-small')}</div>`;
    } else if (opening.status === 'filled') {
      body = `<div class="status-body completed"><h4><span class="status-icon" aria-hidden="true">✓</span> All set for ${escapeHTML(clientName(opening.winner))}</h4><p>Staff marked this booking updated in Square. No calendar changes were made automatically.</p></div>`;
    } else if (opening.status === 'unfilled') {
      body = `<div class="status-body"><h4>No eligible clients left to invite.</h4><p>${escapeHTML(opening.terminalReason || 'The opening remains unfilled. The front desk has been notified.')}</p></div>`;
    } else if (opening.status === 'cancelled') {
      body = `<div class="status-body"><h4>The search has stopped.</h4><p>${escapeHTML(opening.terminalReason || 'Outstanding offers can no longer be accepted.')}</p></div>`;
    } else {
      body = '<div class="status-body"><p>Preparing the next invitation…</p></div>';
    }
    const queue = activeStatuses.has(opening.status)
      ? `<div class="card-queue"><div class="queue-copy"><strong>${remaining.length} ${remaining.length === 1 ? 'client' : 'clients'} next in line</strong>${remaining.length ? `<br>Next: ${escapeHTML(remaining[0].name)}` : '<br>The front desk is notified if nobody accepts.'}</div><div class="queue-avatars" aria-label="Upcoming eligible clients">${remaining.slice(0, 4).map(client => `<span title="${escapeHTML(client.name)}">${escapeHTML(initials(client.name))}</span>`).join('')}${remaining.length > 4 ? `<span>+${remaining.length - 4}</span>` : ''}</div></div>` : '';
    const footer = activeStatuses.has(opening.status) || opening.status === 'accepted'
      ? `<div class="card-footer"><div class="staff-actions">${activeStatuses.has(opening.status) ? staffButton('phone', 'Record phone booking') : ''}${staffButton('cancel', opening.status === 'accepted' ? 'Cancel held opening' : 'Stop search', 'button button-text danger')}</div><span class="soft-label">STAFF CONTROLS</span></div>` : '';
    return `<article class="opening-card ${escapeHTML(opening.status)}${offer?.question && activeStatuses.has(opening.status) ? ' has-question' : ''}" aria-label="${escapeHTML(opening.service)} with ${escapeHTML(opening.stylist)} at ${escapeHTML(formatTime(opening.startsAt))}"><div class="card-head"><div class="appointment-summary"><div class="time-block">${escapeHTML(formatTime(opening.startsAt))}<span>${escapeHTML(date)}</span></div><div class="appointment-divider"></div><div class="appointment-details"><h3>${escapeHTML(opening.service)} with ${escapeHTML(opening.stylist)}</h3><p>${opening.duration} minutes · ${opening.mode === 'demo' ? 'Accelerated demo' : 'Standard offer window'}</p></div></div><span class="badge badge-${escapeHTML(opening.status)}">${escapeHTML(status)}</span></div>${body}${queue}${footer}<details class="card-history" data-opening="${id}" ${expanded ? 'open' : ''}><summary>Activity &amp; details <span>${history.length} ${history.length === 1 ? 'event' : 'events'}</span></summary><ol>${history.map(event => `<li><time datetime="${new Date(event.at).toISOString()}">${escapeHTML(exactTime(event.at))}</time><span>${escapeHTML(event.message)}</span></li>`).join('')}</ol><div class="workflow-details"><strong>Opening:</strong> ${id}${state.data.workflowId ? `<br><strong>Temporal workflow:</strong> ${escapeHTML(state.data.workflowId)}` : ''}${offer ? `<br><strong>Current offer:</strong> ${escapeHTML(offer.id)}` : ''}</div></details></article>`;
  }

  function renderOffers() {
    const offerSelect = $('#reply-offer');
    const previousSelection = offerSelect.value;
    const offers = [...state.data.openings].sort((a, b) => b.createdAt - a.createdAt).flatMap(opening => [...opening.offers].reverse().map(offer => ({ opening, offer, value: `${opening.id}|${offer.id}` })));
    if (!offers.some(item => item.value === state.selectedOffer)) {
      state.selectedOffer = offers.find(item => item.offer.status === 'pending')?.value || offers[0]?.value || '';
    }
    const options = offers.map(({ opening, offer, value }) => `<option value="${escapeHTML(value)}">${escapeHTML(offer.clientName)} · ${escapeHTML(offerStatusLabels[offer.status] || offer.status)} · ${escapeHTML(formatTime(opening.startsAt))} ${escapeHTML(opening.stylist)}</option>`).join('');
    offerSelect.innerHTML = options || '<option value="">Create an opening to begin</option>';
    offerSelect.disabled = !offers.length || state.busy;
    offerSelect.value = state.selectedOffer;
    if (previousSelection !== state.selectedOffer) $('#reply-result').hidden = true;
    updateReplyContext();
    updateReplyButtons();
  }

  function selectedOffer() {
    if (!state.data || !state.selectedOffer) return null;
    const [openingId, offerId] = state.selectedOffer.split('|');
    const opening = state.data.openings.find(item => item.id === openingId);
    const offer = opening?.offers.find(item => item.id === offerId);
    return opening && offer ? { opening, offer } : null;
  }

  function updateReplyContext() {
    const selected = selectedOffer();
    if (!selected) { $('#reply-context').textContent = 'No offers yet. Add an opening to invite the first eligible client.'; return; }
    const { opening, offer } = selected;
    const live = offer.status === 'pending' && opening.currentOfferId === offer.id && opening.status === 'offering' && offer.deadline > Date.now();
    $('#reply-context').innerHTML = `<strong>${escapeHTML(offer.clientName)}</strong> · ${escapeHTML(opening.service)} with ${escapeHTML(opening.stylist)}<br>${live ? `Exclusive until ${escapeHTML(exactTime(offer.deadline))}.` : `This offer is ${escapeHTML(offerStatusLabels[offer.status]?.toLowerCase() || offer.status)}. You can test a reply; the service checks whether it is still valid.`}`;
  }

  function updateReplyButtons() {
    $$('[data-reply]').forEach(button => { button.disabled = !state.connected || !state.selectedOffer || state.busy; });
    $('#reply-offer').disabled = !state.selectedOffer || state.busy;
  }

  function renderWaitlist(clients) {
    const liveOffers = new Set(state.data.openings.filter(opening => activeStatuses.has(opening.status)).flatMap(opening => { const offer = currentOffer(opening); return offer ? [offer.clientId] : []; }));
    const failedClients = new Set(state.data.openings.filter(opening => opening.status === 'attention').map(opening => currentOffer(opening)?.clientId).filter(Boolean));
    const heldClients = new Set(state.data.openings.filter(opening => opening.status === 'accepted').map(opening => currentOffer(opening)?.clientId).filter(Boolean));
    $('#waitlist-body').innerHTML = [...clients].sort((a, b) => a.joined - b.joined).map(client => {
      const status = client.optedOut ? 'Opted out' : heldClients.has(client.id) ? 'Held · Square pending' : client.fulfilled ? 'Booked' : failedClients.has(client.id) ? 'Needs staff' : liveOffers.has(client.id) ? 'Invited' : 'Waiting';
      return `<tr><td><span class="table-name">${escapeHTML(client.name)}</span><span class="table-sub">Fictional client</span></td><td>${escapeHTML(client.service)}<span class="table-sub">${client.duration} min</span></td><td>${escapeHTML(client.stylist === 'Any' ? 'Any stylist' : client.stylist)}</td><td>${escapeHTML(client.availableFrom)}–${escapeHTML(client.availableTo)}</td><td><span class="client-status${client.optedOut || client.fulfilled ? ' inactive' : ''}">${status}</span></td></tr>`;
    }).join('') || '<tr><td colspan="5">No clients on the waitlist.</td></tr>';
  }

  function renderMessages(notifications) {
    $('#message-list').innerHTML = [...notifications].sort((a, b) => b.at - a.at).slice(0, 40).map(notice => `<article class="message${notice.outcome === 'failed' ? ' failed' : ''}"><div class="message-head"><strong>${escapeHTML(notice.audience)}</strong><time datetime="${new Date(notice.at).toISOString()}" title="${escapeHTML(new Date(notice.at).toLocaleString())}">${escapeHTML(exactTime(notice.at))}</time></div><p>${escapeHTML(localizeMessage(notice.message))}</p><span class="message-outcome">${notice.outcome === 'failed' ? 'DELIVERY FAILED · SIMULATED' : 'SIMULATED · NOT ACTUALLY SENT'}</span></article>`).join('') || '<p class="quiet-empty">Your first invitation will appear here.</p>';
  }

  function tick() {
    const now = Date.now();
    $$('[data-deadline]').forEach(element => {
      const seconds = Math.max(0, Math.ceil((Number(element.dataset.deadline) - now) / 1000));
      element.textContent = seconds ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : 'Advancing…';
    });
    $$('[data-progress-deadline]').forEach(element => {
      const deadline = Number(element.dataset.progressDeadline);
      const created = Number(element.dataset.created);
      const remaining = Math.max(0, Math.min(100, (deadline - now) / Math.max(1, deadline - created) * 100));
      element.setAttribute('aria-valuenow', String(Math.round(remaining)));
      $('.progress-fill', element).style.width = `${remaining}%`;
      $('.progress-fill', element).classList.toggle('urgent', remaining < 25);
    });
    updateReplyContext();
  }

  function openCreateDialog() {
    const now = new Date();
    const date = new Date(now.getTime() + 60 * 60 * 1000);
    date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
    if (date.getDate() !== now.getDate()) date.setTime(now.getTime() + 2 * 60 * 1000);
    $('#opening-start').value = localDateTime(date);
    $('#opening-start').min = localDateTime(new Date(now.getTime() + 60 * 1000));
    $('#opening-start').max = `${localDateTime(now).slice(0, 10)}T23:59`;
    $('#create-error').hidden = true;
    $('#opening-dialog').showModal();
  }

  $('#new-opening-button').addEventListener('click', openCreateDialog);
  $('#about-button').addEventListener('click', () => $('#about-dialog').showModal());
  $$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }));

  $('#opening-service').addEventListener('change', () => {
    if ($('#opening-service').value === 'Color') $('#opening-duration').value = '90';
    else $('#opening-duration').value = '60';
  });

  $('#opening-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const startsAt = new Date(String(values.get('startsAt'))).getTime();
    const date = new Date(startsAt);
    const now = new Date();
    const showError = message => { $('#create-error').textContent = message; $('#create-error').hidden = false; };
    if (!Number.isFinite(startsAt) || startsAt <= Date.now()) return showError('Choose a time later today.');
    if (date.toDateString() !== now.toDateString()) return showError('This prototype is for same-day openings. Choose today’s date.');
    $('#create-error').hidden = true;
    const button = $('#create-button');
    button.textContent = 'Starting invitations…';
    try {
      const result = await command({ type: 'create', id: crypto.randomUUID(), service: values.get('service'), stylist: values.get('stylist'), duration: Number(values.get('duration')), startsAt, localTime: String(values.get('startsAt')).slice(11, 16), mode: values.get('mode'), failDelivery: values.get('failDelivery') === 'on' });
      if (!result) return;
      $('#opening-dialog').close();
      state.filter = 'all';
      updateFilters();
      const opening = state.data?.openings.find(item => item.id === result.openingId);
      if (opening?.offers.length) state.selectedOffer = `${opening.id}|${opening.offers[opening.offers.length - 1].id}`;
      render();
      toast(result.message || 'The opening is ready. Invitations have begun.');
      $('#openings').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { showError(error.message); }
    finally { button.innerHTML = 'Start inviting <span aria-hidden="true">↗</span>'; }
  });

  function updateFilters() {
    $$('.filter').forEach(button => { const selected = button.dataset.filter === state.filter; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
  }
  $$('.filter').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; updateFilters(); if (state.data) renderOpenings(); }));

  $('#reply-offer').addEventListener('change', event => { state.selectedOffer = event.target.value; $('#reply-result').hidden = true; updateReplyContext(); });
  $$('[data-reply]').forEach(button => button.addEventListener('click', async () => {
    const selected = selectedOffer();
    if (!selected) return;
    const resultBox = $('#reply-result');
    const response = button.dataset.reply;
    const payload = { type: 'reply', openingId: selected.opening.id, offerId: selected.offer.id, response };
    if (response === 'question') payload.message = $('#question-text').value.trim() || 'Could I arrive ten minutes later?';
    resultBox.hidden = false;
    resultBox.classList.remove('error');
    resultBox.textContent = 'Checking this reply against the current offer…';
    try {
      const result = await command(payload);
      if (!result) return;
      resultBox.textContent = result.message;
      toast(result.message);
    } catch (error) {
      resultBox.classList.add('error');
      resultBox.textContent = error.message;
      toast(error.message, true);
      await refresh();
    }
  }));

  $('#opening-list').addEventListener('click', async event => {
    const newOpening = event.target.closest('[data-new-opening]');
    if (newOpening) { openCreateDialog(); return; }
    const button = event.target.closest('[data-staff]');
    if (!button || state.busy) return;
    const { opening: openingId, staff: action } = button.dataset;
    if (action === 'phone' || action === 'cancel') {
      state.staffAction = { openingId, action };
      const phone = action === 'phone';
      $('#staff-dialog-title').textContent = phone ? 'Record a phone booking' : 'Stop this search';
      $('#staff-dialog-description').textContent = phone ? 'First record the phone booking in Square, then confirm it here. This marks the opening filled and cancels the outstanding invitation so nobody else can claim it.' : 'The outstanding invitation will no longer be valid. Use this if the original client returns, the stylist is unavailable, or the opening is no longer available. If an opening is held, notify the client and handle any calendar changes manually.';
      $('#staff-reason-label').textContent = phone ? 'Name of the client who booked by phone' : 'Reason for stopping';
      $('#staff-reason').placeholder = phone ? 'e.g. Alex Morgan' : 'e.g. Original appointment restored';
      $('#staff-reason').value = '';
      $('#square-attestation-row').hidden = !phone;
      $('#square-attestation').checked = false;
      $('#square-attestation').required = phone;
      $('#staff-submit').textContent = phone ? 'Record booking' : 'Stop search';
      $('#staff-error').hidden = true;
      $('#staff-dialog').showModal();
      return;
    }
    try {
      const result = await command({ type: 'staff', openingId, action });
      if (result) toast(result.message);
    } catch (error) { toast(error.message, true); await refresh(); }
  });

  $('#staff-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.staffAction) return;
    if (state.staffAction.action === 'phone' && !$('#square-attestation').checked) {
      $('#staff-error').hidden = false;
      $('#staff-error').textContent = 'Update Square first, then confirm that you have done so.';
      return;
    }
    const reason = $('#staff-reason').value.trim();
    if (!reason) { $('#staff-error').hidden = false; $('#staff-error').textContent = 'Please add a name or reason before continuing.'; return; }
    try {
      const result = await command({ type: 'staff', ...state.staffAction, reason });
      if (!result) return;
      $('#staff-dialog').close();
      toast(result.message);
    } catch (error) { $('#staff-error').hidden = false; $('#staff-error').textContent = error.message; }
  });

  refresh();
  setInterval(refresh, 1500);
  setInterval(tick, 250);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
