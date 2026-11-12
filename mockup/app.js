// Weft mockup: tabs inside the page, a persistent chat rail, an assistant that cites sources.
// All data is sample data. Nothing is saved; state lives in the URL hash.
(() => {
  const APPS = {
    documents: { label: 'Run of show', tint: '--p-thu' },
    wiki: { label: 'Rain plan', tint: '--p-fri' },
    whiteboard: { label: 'Porch map', tint: '--p-wed' },
    sheets: { label: 'Schedule', tint: '--p-tue' },
    calendar: { label: 'Calendar', tint: '--p-mon' },
    files: { label: 'Files', tint: '--p-sat' },
  };

  const msg = (who, time, text, extra = {}) => ({ who, time, text, ...extra });
  const CONVOS = {
    weft: {
      title: 'Weft', sub: 'Answers from the docs, sheets and chats you can open.', placeholder: 'Message Weft, or @Weft in any channel',
      messages: [
        msg('You', '09:12', 'Who plays P02 at 14:00, and what is the rain plan there?', { me: true }),
        msg('Weft', '09:12', 'The Lucky Orchard, a classical act, is confirmed for P02 at 14:00. If it rains, P02 moves to P01.',
          { agent: true, sources: [['Schedule sheet, row 18', 'sheets', 18], ['Wiki: Rain plan', 'wiki']] }),
      ],
    },
    festival: {
      title: '# festival', sub: 'Olive, Vic, Pat and you', placeholder: 'Message #festival',
      messages: [
        msg('Olive Organizer', '08:30', 'Schedule is locked for Saturday. Post here if a porch changes.'),
        msg('Vic Volunteer', '08:52', '@Weft which porches have no power?'),
        msg('Weft', '08:52', 'Eight porches have no power: P01, P03, P05, P06, P07, P09, P13 and P17. Acts that need power should not be booked there.',
          { agent: true, sources: [['Porches sheet, power column', 'sheets']] }),
        msg('Pat Public', '09:01', 'Is the 13:00 set at P04 still on?'),
      ],
    },
    volunteers: { title: '# volunteers', sub: 'Olive, Vic and you', placeholder: 'Message #volunteers',
      messages: [msg('Olive Organizer', 'Mon', 'Check-in is at the info booth from 11:00. Captains, grab your signs.')] },
    organizers: { title: '# organizers', sub: 'Olive and you', placeholder: 'Message #organizers',
      messages: [msg('Olive Organizer', 'Mon', 'Host contact sheet is updated. Only organizers can see it, Weft included when Vic or Pat ask.')] },
    olive: { title: 'Olive Organizer', sub: 'Direct message', placeholder: 'Message Olive',
      messages: [msg('Olive Organizer', '09:04', 'Can you look over the run of show before Friday?', { sources: [['Run of show', 'documents']] })] },
    vic: { title: 'Vic Volunteer', sub: 'Direct message', placeholder: 'Message Vic',
      messages: [msg('Vic Volunteer', 'Yesterday', 'I put the porch map on the whiteboard.', { sources: [['Porch map', 'whiteboard']] })] },
  };

  const $ = (s, el = document) => el.querySelector(s);
  const tabsEl = $('#tabs');
  const stage = $('.stage');
  let state = { tabs: [], active: 'home', convo: 'weft', row: null };

  // ---------- URL state ----------
  const readHash = () => {
    const h = new URLSearchParams(location.hash.slice(1));
    const tabs = (h.get('tabs') || '').split(',').filter((t) => APPS[t]);
    const active = h.get('active');
    return { tabs, active: active === 'home' || tabs.includes(active) ? active : 'home', convo: CONVOS[h.get('convo')] ? h.get('convo') : 'weft', row: h.get('row') };
  };
  const writeHash = () => {
    const h = new URLSearchParams();
    if (state.tabs.length) h.set('tabs', state.tabs.join(','));
    h.set('active', state.active);
    h.set('convo', state.convo);
    if (state.row) h.set('row', state.row);
    history.replaceState(null, '', '#' + h.toString());
  };

  // ---------- tabs ----------
  const panelFor = (id) => $(`#panel-${id}`);

  function buildPanel(id) {
    const panel = document.createElement('section');
    panel.className = 'panel'; panel.id = `panel-${id}`; panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${id}`); panel.hidden = true;
    panel.append($('#app-loading').content.cloneNode(true));
    stage.append(panel);
    // Loading state for a beat, then the app itself.
    setTimeout(() => { panel.replaceChildren($(`#app-${id}`).content.cloneNode(true)); highlightRow(); }, 350);
    return panel;
  }

  function buildTab(id) {
    const tab = document.createElement('button');
    tab.className = 'tab'; tab.id = `tab-${id}`; tab.dataset.tab = id;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false');
    const dot = document.createElement('span'); dot.className = 'tab-dot'; dot.style.setProperty('--t', `var(${APPS[id].tint})`); dot.setAttribute('aria-hidden', 'true');
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×';
    close.setAttribute('role', 'button'); close.setAttribute('aria-label', `Close ${APPS[id].label}`); close.dataset.close = id;
    tab.append(dot, document.createTextNode(APPS[id].label), close);
    tabsEl.append(tab);
  }

  function activate(id) {
    state.active = id;
    for (const t of tabsEl.querySelectorAll('.tab')) {
      const on = t.dataset.tab === id;
      t.classList.toggle('is-active', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
    }
    for (const p of stage.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${id}`;
    writeHash();
  }

  function open(id, row) {
    if (!APPS[id]) return activate('home');
    if (!state.tabs.includes(id)) { state.tabs.push(id); buildTab(id); buildPanel(id); }
    state.row = id === 'sheets' && row ? String(row) : state.row;
    activate(id);
    highlightRow();
    $(`#tab-${id}`).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function close(id) {
    const i = state.tabs.indexOf(id);
    if (i < 0) return;
    state.tabs.splice(i, 1);
    $(`#tab-${id}`).remove(); panelFor(id).remove();
    if (id === 'sheets') state.row = null;
    activate(state.active === id ? (state.tabs[i - 1] || state.tabs[i] || 'home') : state.active);
  }

  function highlightRow() {
    const panel = panelFor('sheets');
    if (!panel) return;
    for (const tr of panel.querySelectorAll('tr[data-row]')) tr.classList.toggle('is-highlight', tr.dataset.row === state.row);
    const hit = state.row && panel.querySelector(`tr[data-row="${state.row}"]`);
    if (hit && state.active === 'sheets') hit.scrollIntoView({ block: 'center' });
  }

  // ---------- chat ----------
  function renderConvo(id) {
    state.convo = id;
    const c = CONVOS[id];
    $('#thread-title').textContent = c.title;
    $('#thread-sub').textContent = c.sub;
    $('#compose').placeholder = c.placeholder;
    for (const b of document.querySelectorAll('.convo')) {
      const on = b.dataset.convo === id;
      b.classList.toggle('is-active', on);
      if (on) { b.setAttribute('aria-current', 'true'); b.querySelector('.convo-count')?.remove(); } else b.removeAttribute('aria-current');
    }
    const list = $('#messages');
    list.replaceChildren(...c.messages.map(renderMsg));
    list.scrollTop = list.scrollHeight;
    writeHash();
  }

  function renderMsg(m) {
    const li = document.createElement('li');
    li.className = 'msg' + (m.me ? ' msg--me' : '') + (m.agent ? ' msg--agent' : '');
    const who = document.createElement('p'); who.className = 'msg-who';
    who.textContent = m.me ? 'You ' : `${m.who} `;
    const t = document.createElement('time'); t.textContent = m.time; who.append(t);
    const body = document.createElement('p');
    for (const part of m.text.split(/(@Weft)/)) {
      if (part === '@Weft') { const s = document.createElement('span'); s.className = 'mention'; s.textContent = part; body.append(s); }
      else body.append(document.createTextNode(part));
    }
    li.append(who, body);
    if (m.sources) {
      const src = document.createElement('p'); src.className = 'sources';
      for (const [label, app, row] of m.sources) {
        const a = document.createElement('a'); a.className = 'source'; a.href = `#${app}`; a.dataset.open = app;
        if (row) a.dataset.row = row;
        a.textContent = label; src.append(a);
      }
      li.append(src);
    }
    return li;
  }

  const now = () => new Date().toTimeString().slice(0, 5);

  function send(text) {
    const c = CONVOS[state.convo];
    c.messages.push(msg('You', now(), text, { me: true }));
    renderConvo(state.convo);
    const asksAgent = state.convo === 'weft' || /@weft/i.test(text);
    if (!asksAgent) return;
    setTimeout(() => {
      c.messages.push(msg('Weft', now(),
        'This is a mockup, so I cannot search yet. In Weft I would answer from the documents, sheets, whiteboards and chats you can open, and link every source so you can check it.',
        { agent: true }));
      if (state.convo === Object.keys(CONVOS).find((k) => CONVOS[k] === c)) renderConvo(state.convo);
    }, 700);
  }

  // ---------- wiring ----------
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) { e.stopPropagation(); close(closer.dataset.close); return; }
    const opener = e.target.closest('[data-open]');
    if (opener) { e.preventDefault(); open(opener.dataset.open, opener.dataset.row); return; }
    const tab = e.target.closest('.tab');
    if (tab) { activate(tab.dataset.tab); return; }
    const convo = e.target.closest('.convo');
    if (convo) renderConvo(convo.dataset.convo);
  });

  // Arrow keys move along the tab strip; Delete closes a tab.
  tabsEl.addEventListener('keydown', (e) => {
    const tabs = [...tabsEl.querySelectorAll('.tab')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      activate(next.dataset.tab); next.focus(); e.preventDefault();
    } else if (e.key === 'Delete' && tabs[i].dataset.tab !== 'home') {
      close(tabs[i].dataset.tab); $(`#tab-${state.active}`).focus();
    }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#compose');
    const text = input.value.trim();
    if (text) { send(text); input.value = ''; }
  });

  // Restore from the URL.
  const saved = readHash();
  state.row = saved.row;
  for (const t of saved.tabs) { state.tabs.push(t); buildTab(t); buildPanel(t); }
  activate(saved.active);
  renderConvo(saved.convo);
})();
