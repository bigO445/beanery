/* ==========================================================================
   BEANERY — QR menu interactivity
   Independent behaviours: live search, sticky category nav that tracks
   scroll position, and the cart.
   ========================================================================== */

(() => {
  'use strict';

  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const searchInput = $('#q');
  const clearBtn    = $('#clear');
  const noResults   = $('#noresults');
  const resetBtn    = $('#resetSearch');
  const sections    = $$('.sec');
  const catLinks    = $$('.cat');
  const catsTrack   = $('.cats__track');

  /* ---------- search ---------- */

  const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

  function runSearch() {
    const term = norm(searchInput.value.trim());
    clearBtn.hidden = term.length === 0;
    document.body.classList.toggle('is-searching', term.length > 0);

    let anyVisible = false;

    sections.forEach((sec) => {
      const items = $$('.item, .pcard', sec);
      let matches = 0;

      items.forEach((item) => {
        const name = item.querySelector('.item__name, .pcard__name');
        const text = norm(name ? name.textContent : item.textContent);
        const hit = term === '' || text.includes(term);
        item.classList.toggle('is-hidden', !hit);
        if (hit) matches++;
      });

      const sectionMatches = term === '' || matches > 0;
      sec.classList.toggle('is-hidden', !sectionMatches);
      if (sectionMatches) anyVisible = true;
    });

    noResults.hidden = anyVisible;
  }

  searchInput.addEventListener('input', runSearch);

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    runSearch();
    searchInput.focus();
  });

  resetBtn.addEventListener('click', () => {
    searchInput.value = '';
    runSearch();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      runSearch();
    }
  });

  /* ---------- sticky category nav: active state on scroll ---------- */

  const catByHref = new Map(catLinks.map((a) => [a.getAttribute('href').slice(1), a]));

  function setActiveCat(id) {
    const target = catByHref.get(id);
    if (!target) return;
    catLinks.forEach((a) => a.classList.toggle('is-on', a === target));
    // keep the active pill in view within the horizontally scrolling track —
    // scroll catsTrack directly (never scrollIntoView) so this can't ever
    // touch the page's own vertical scroll position while the user scrolls
    const trackRect = catsTrack.getBoundingClientRect();
    const linkRect = target.getBoundingClientRect();
    if (linkRect.left < trackRect.left || linkRect.right > trackRect.right) {
      const targetCenter = target.offsetLeft + target.offsetWidth / 2;
      catsTrack.scrollTo({ left: targetCenter - catsTrack.clientWidth / 2, behavior: 'smooth' });
    }
  }

  const headEl = $('#cats');
  const headH = () => (headEl ? headEl.offsetHeight : 58);

  let observerLock = false;
  const io = new IntersectionObserver(
    (entries) => {
      if (observerLock) return;
      entries.forEach((entry) => {
        if (entry.isIntersecting) setActiveCat(entry.target.id);
      });
    },
    { rootMargin: `-${headH() + 8}px 0px -70% 0px`, threshold: 0 }
  );
  sections.forEach((sec) => io.observe(sec));

  // instant feedback on click, without waiting for the observer to catch up
  function onCatJump(a) {
    observerLock = true;
    setActiveCat(a.getAttribute('href').slice(1));
    window.setTimeout(() => { observerLock = false; }, 700);
  }
  catLinks.forEach((a) => a.addEventListener('click', () => onCatJump(a)));

  /* scroll reveal removed — sections render in their final state right away */

  /* ---------- card-row carousels: arrow scroll + edge-aware disable ---------- */

  $$('.cardrow').forEach((row) => {
    const track = $('.cardrow__track', row);
    const prev = $('.cardrow__arrow--prev', row);
    const next = $('.cardrow__arrow--next', row);
    if (!track || !prev || !next) return;

    const step = () => Math.min(track.clientWidth * 0.8, 340);

    function updateArrows() {
      const max = track.scrollWidth - track.clientWidth;
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft >= max - 4;
    }

    prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
    track.addEventListener('scroll', updateArrows, { passive: true });
    window.addEventListener('resize', updateArrows);
    updateArrows();
  });

  /* ---------- cart ---------- */

  const CART_KEY = 'beanery_cart_v1';

  /* Orders already sent to the counter, kept apart from the cart on purpose.
   * The cart is what the guest can still change; this is what the kitchen is
   * already making. Merging them into one list would offer an edit nobody can
   * honour, so they never share a store or a render path. */
  const ORDERS_KEY = 'beanery_orders_v1';

  /* How long a sitting lasts. A QR token can outlive the guest holding it --
   * the next person at that table would otherwise open the menu and be shown
   * someone else's bill. Four hours covers a long lunch and expires well
   * before the table turns over twice. */
  const ORDERS_TTL_MS = 4 * 60 * 60 * 1000;

  /* Where the menu is read from, and where the finished order goes.
   *
   * Both same-origin on purpose. These are this site's own Worker routes; the
   * Worker adds a shared secret and forwards to the POS. So the POS hostname
   * never appears in this file or in a guest's network tab, and there is no
   * CORS to configure, because nothing here is cross-origin. */
  const MENU_ENDPOINT  = '/api/menu';
  const ORDER_ENDPOINT = '/api/order';

  const cartBtn        = $('#cartBtn');
  const cartBadge      = $('#cartBadge');
  const cartBarLabel   = $('#cartBarLabel');
  const cartBarTotalEl = $('#cartBarTotal');
  const cartOverlay    = $('#cartOverlay');
  const cartPanel      = $('#cartPanel');
  const cartCloseBtn   = $('#cartClose');
  const cartTable      = $('#cartTable');
  const cartTableNum   = $('#cartTableNum');
  const cartCountLabel = $('#cartCountLabel');
  const cartEmpty      = $('#cartEmpty');
  const cartListEl     = $('#cartList');
  const cartFoot       = $('#cartFoot');
  const cartTotalEl    = $('#cartTotal');
  const cartSend       = $('#cartSend');
  const cartSendLabel  = $('#cartSendLabel');
  const cartStatus     = $('#cartStatus');
  const cartScroll     = $('#cartScroll');
  const cartPrev       = $('#cartPrev');
  const cartPrevList   = $('#cartPrevList');
  const cartPrevTitle  = $('#cartPrevTitle');
  const cartResume     = $('#cartResume');
  const cartNew        = $('#cartNew');
  const cartTabs       = $('#cartTabs');
  const tabPrev        = $('#tabPrev');
  const tabNew         = $('#tabNew');
  const tabPrevN       = $('#tabPrevN');
  const tabNewN        = $('#tabNewN');
  const cartSumPrev    = $('#cartSumPrev');
  const cartSumNew     = $('#cartSumNew');
  const cartPrevTotal  = $('#cartPrevTotal');
  const cartNewTotal   = $('#cartNewTotal');
  const cartTotalLabel = $('#cartTotalLabel');
  const cartBrowse     = $('#cartBrowse');
  const cartDone       = $('#cartDone');
  const cartDoneSub    = $('#cartDoneSub');
  const cartDoneList   = $('#cartDoneList');
  const cartDoneTotal  = $('#cartDoneTotal');
  const cartDoneMore   = $('#cartDoneMore');

  const SEND_LABEL_DEFAULT = cartSendLabel.textContent;

  /* The QR token this menu was opened with: /menu/?t=<64 hex chars>.
   *
   * A token rather than a table number, because it is the credential. It is
   * what tells the POS both which cafe and which table, and unlike "?table=7"
   * it cannot be typed from a guess — otherwise anyone could send drinks to
   * anyone's table.
   *
   * No token means someone opened beanery-cafe.com/menu/ directly instead of
   * scanning. They get the menu; they do not get to order. */
  const QR_TOKEN = (new URLSearchParams(window.location.search).get('t') || '').trim();
  const canOrder = /^[a-f0-9]{64}$/.test(QR_TOKEN);

  // Filled in from the POS once the live menu loads — the QR knows the table,
  // this page does not until it asks.
  let TABLE_NUMBER = null;

  if (!canOrder) document.body.classList.add('is-browsing');

  const parsePrice = (text) => {
    const digits = (text || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : NaN;
  };

  // The POS price if the live sync has supplied one, else what is printed on
  // the page. Read at click time, never captured in a closure.
  const priceOf = (el, fallback) => {
    const live = Number(el && el.dataset ? el.dataset.price : NaN);
    return Number.isFinite(live) && live > 0 ? live : fallback;
  };

  // strips the "New" ribbon (and anything else non-text) out of a name
  // before it becomes a cart line / aria-label
  const cleanName = (el) => {
    const clone = el.cloneNode(true);
    $$('.new', clone).forEach((b) => b.remove());
    return clone.textContent.trim();
  };

  const fmt = (n) => n.toLocaleString('en-US');

  // a special-request note is free text a customer typed, so it must be
  // escaped before it ever lands back in innerHTML
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  let cart = [];
  try {
    cart = JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    cart = [];
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* private browsing / storage disabled — cart just won't survive a reload */
    }
  }

  /* ---------- orders already sent ----------
   *
   * Stored under the QR token that sent them. A different token is a different
   * table (or a re-issued one), and inheriting the last guest's order there
   * would be worse than forgetting it, so a mismatch reads as none. Anything
   * older than the sitting is dropped for the same reason. */

  let placed = [];

  function loadPlaced() {
    if (!canOrder) return [];
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(ORDERS_KEY)); } catch { return []; }
    if (!raw || raw.token !== QR_TOKEN || !Array.isArray(raw.orders)) return [];
    const cutoff = Date.now() - ORDERS_TTL_MS;
    return raw.orders.filter((o) => o && Array.isArray(o.lines) && typeof o.at === 'number' && o.at > cutoff);
  }

  function savePlaced() {
    try {
      localStorage.setItem(ORDERS_KEY, JSON.stringify({ token: QR_TOKEN, orders: placed }));
    } catch {
      /* same as the cart: storage off just means it won't survive a reload */
    }
  }

  placed = loadPlaced();

  /* A sent line is a receipt, not a cart row: copied by value so a later
   * re-price or edit of the live cart can never reach back and rewrite what
   * the guest was already told they'd pay. posId is dropped with it — this
   * copy exists to be read, never to be sent again. */
  const snapshotLine = (l) => ({
    name: l.name,
    price: l.price,
    qty: l.qty,
    addons: (l.addons || []).map((a) => ({ name: a.name, price: a.price })),
    note: l.note || '',
  });

  function bumpCartBar() {
    cartBtn.classList.remove('cartbar--bump');
    void cartBtn.offsetWidth; // restart the animation on back-to-back adds
    cartBtn.classList.add('cartbar--bump');
  }

  // add-ons travel with the drink that carries them — one cart line, the
  // drink as root and its add-ons nested inside as children — rather than
  // becoming their own top-level lines. Two lines only merge (qty++) when
  // both the drink AND its exact set of add-ons match.
  const addonsKey = (addons) => (addons || [])
    .map((a) => `${a.name}|${a.price}`)
    .sort()
    .join('~');

  const lineUnitPrice = (line) => line.price + (line.addons || []).reduce((s, a) => s + a.price, 0);

  function addToCart(name, price, img, addons, note, posId) {
    const addonList = addons && addons.length ? addons : [];
    const noteText = (note || '').trim();
    const key = addonsKey(addonList);
    // a written note is as distinguishing as the add-on set — two lines
    // only merge (qty++) when the drink, its add-ons, AND its note all match
    const line = cart.find((l) => l.name === name && l.price === price
      && addonsKey(l.addons) === key && (l.note || '') === noteText);
    if (line) line.qty += 1;
    // posId is what the POS actually orders by; the name and price here are
    // for the guest to read. A line without one can still sit in the cart, it
    // just cannot be sent — see collectOrderLines().
    else cart.push({ name, price, qty: 1, img: img || null, addons: addonList, note: noteText, posId: posId || null });
    // whatever they were looking at, adding an item means they are building
    // the next round — so that is the tab the cart should open on
    activeTab = 'new';
    saveCart();
    renderCart();
    bumpCartBar();
  }

  function setQty(index, qty) {
    if (qty <= 0) cart.splice(index, 1);
    else cart[index].qty = qty;
    saveCart();
    renderCart();
  }

  const cartCount = () => cart.reduce((n, l) => n + l.qty, 0);
  const cartTotal = () => cart.reduce((sum, l) => sum + lineUnitPrice(l) * l.qty, 0);

  const linesTotal  = (lines) => lines.reduce((sum, l) => sum + lineUnitPrice(l) * l.qty, 0);
  const linesCount  = (lines) => lines.reduce((n, l) => n + l.qty, 0);
  const placedTotal = () => placed.reduce((sum, o) => sum + linesTotal(o.lines), 0);
  const placedCount = () => placed.reduce((n, o) => n + linesCount(o.lines), 0);

  const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /* One sent line, rendered the same whether it appears on the receipt or in
   * the "already ordered" list — same money in both places, or the guest is
   * right to distrust both. Names are escaped like notes: they mostly come
   * from the page, but a POS-supplied one has been through a till nobody
   * here controls. */
  const sentLineHtml = (line) => {
    const unit = lineUnitPrice(line);
    const addons = (line.addons || []).length
      ? `<ul class="cart__sent__addons">${line.addons.map((a) => `
          <li><span>${escapeHtml(a.name)}</span><span class="cart__sent__plus">+${fmt(a.price)}</span></li>`).join('')}
        </ul>`
      : '';
    const note = line.note ? `<p class="cart__sent__note">"${escapeHtml(line.note)}"</p>` : '';
    return `
      <li class="cart__sent__line">
        <span class="cart__sent__qty">${line.qty}&times;</span>
        <span class="cart__sent__body">
          <span class="cart__sent__name">${escapeHtml(line.name)}</span>
          ${addons}${note}
        </span>
        <span class="cart__sent__price">${fmt(unit * line.qty)}</span>
      </li>`;
  };

  /* Each send is its own group, numbered and timestamped. Two rounds of the
   * same drink an hour apart are two facts about the evening, not one line
   * with qty 2 — collapsing them would lose which round is already on the
   * table. */
  function renderPlaced() {
    cartPrev.hidden = placed.length === 0;
    if (placed.length === 0) { cartPrevList.innerHTML = ''; return; }

    cartPrevList.innerHTML = placed.map((o, i) => `
      <li class="cart__order">
        <div class="cart__order__head">
          <span class="cart__order__label">Order ${i + 1}</span>
          <span class="cart__order__time">${escapeHtml(timeOf(o.at))}</span>
          <span class="cart__order__sum">${fmt(linesTotal(o.lines))} IQD</span>
        </div>
        <ul class="cart__sent">${o.lines.map(sentLineHtml).join('')}</ul>
      </li>`).join('');
  }

  /* Which of the two lists the browse view is showing. Only ever consulted
     when both have something in them; with one side empty there is nothing to
     switch between and renderCart pins it to whichever side has content. */
  let activeTab = 'new';

  /* The panes are only tabs some of the time, so the roles go on and come off
     with the strip — a lone tabpanel with no tablist above it announces a
     control that isn't there. */
  function setPaneRoles(on) {
    [[cartPrev, tabPrev, 'Already ordered'], [cartNew, tabNew, 'Adding now']].forEach(([pane, tab, label]) => {
      if (on) {
        pane.setAttribute('role', 'tabpanel');
        pane.setAttribute('aria-labelledby', tab.id);
        pane.setAttribute('tabindex', '0');
        pane.removeAttribute('aria-label');
      } else {
        pane.removeAttribute('role');
        pane.removeAttribute('aria-labelledby');
        pane.removeAttribute('tabindex');
        pane.setAttribute('aria-label', label);
      }
    });
  }

  function selectTab(name) {
    activeTab = name;
    renderCart();
  }

  tabPrev.addEventListener('click', () => selectTab('prev'));
  tabNew.addEventListener('click', () => selectTab('new'));

  // arrow keys move between tabs, the pattern a screen-reader user expects
  // from a tablist
  cartTabs.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const toNew = e.key === 'ArrowRight' || e.key === 'End';
    selectTab(toNew ? 'new' : 'prev');
    (toNew ? tabNew : tabPrev).focus();
  });

  /* Two views share the panel: the browse view (previous orders + what is
   * being added now) and the receipt shown straight after sending. Kept as
   * views rather than a second dialog so the table chip, the close button and
   * the focus trap all stay where the guest just left them. */
  let cartView = 'cart';

  function setCartView(view) {
    cartView = view;
    cartDone.hidden = view !== 'done';
    cartScroll.hidden = view === 'done';
    renderCart();
  }

  const sendLabelText = () => (placed.length ? 'Send these too' : SEND_LABEL_DEFAULT);

  function renderCart() {
    const count = cartCount();
    const newTotal = cartTotal();
    const prevTotal = placedTotal();
    const grand = newTotal + prevTotal;
    const hasNew = cart.length > 0;
    const hasPrev = placed.length > 0;

    /* the floating bar. Three states, because "nothing yet", "ready to send"
       and "already with the counter" are three different things to a guest. */
    cartBadge.hidden = !hasNew && !hasPrev;
    cartBadge.classList.toggle('cartbar__badge--check', !hasNew && hasPrev);
    if (hasNew) cartBadge.textContent = String(count);
    else if (hasPrev) cartBadge.innerHTML = '<svg aria-hidden="true"><use href="#i-check" /></svg>';

    cartBarLabel.textContent = hasNew ? 'View order' : hasPrev ? 'Ordered' : 'Tap to order';
    cartBarTotalEl.hidden = !hasNew && !hasPrev;
    cartBarTotalEl.textContent = `${fmt(grand)} IQD`;
    cartBtn.classList.toggle('cartbar--invite', !hasNew && !hasPrev);
    cartBtn.classList.toggle('cartbar--sent', !hasNew && hasPrev);
    cartBtn.setAttribute('aria-label', hasNew
      ? `View your order — ${count} ${count === 1 ? 'item' : 'items'}, ${fmt(grand)} IQD`
      : hasPrev
        ? `Ordered — ${fmt(prevTotal)} IQD sent to the counter. Open to see it or add more.`
        : 'View your order — order straight from your table');

    cartCountLabel.textContent = hasNew && hasPrev
      ? `${count} new · ${placedCount()} already ordered`
      : hasNew
        ? `${count} ${count === 1 ? 'item' : 'items'}`
        : hasPrev
          ? `${placedCount()} ${placedCount() === 1 ? 'item' : 'items'} sent to the counter`
          : 'Your cart is empty';

    renderPlaced();

    // the big empty illustration is for a guest who has ordered nothing at
    // all; once something is at the counter the panel isn't empty, it's just
    // between rounds — hence the quieter prompt instead
    cartEmpty.hidden = hasNew || hasPrev;
    cartResume.hidden = hasNew || !hasPrev;

    /* the tab strip earns its space only when both lists have something in
       them. With one side empty there is nothing to switch to, so the strip
       goes away and the surviving list shows on its own. */
    const tabsOn = hasNew && hasPrev;
    if (!hasNew) activeTab = 'prev';
    else if (!hasPrev) activeTab = 'new';

    cartTabs.hidden = !tabsOn;
    tabPrevN.textContent = String(placedCount());
    tabNewN.textContent = String(count);
    setPaneRoles(tabsOn);

    if (tabsOn) {
      const onNew = activeTab === 'new';
      tabNew.setAttribute('aria-selected', String(onNew));
      tabPrev.setAttribute('aria-selected', String(!onNew));
      // roving tabindex: one stop for the whole strip, arrows move within it
      tabNew.tabIndex = onNew ? 0 : -1;
      tabPrev.tabIndex = onNew ? -1 : 0;
      tabNew.classList.toggle('is-on', onNew);
      tabPrev.classList.toggle('is-on', !onNew);
      cartPrev.hidden = onNew;
      cartNew.hidden = !onNew;
    } else {
      cartPrev.hidden = !hasPrev;
      cartNew.hidden = !hasNew;
    }

    // the tab already names the list, so the in-pane heading would only
    // repeat it
    cartPrevTitle.hidden = tabsOn;

    cartFoot.hidden = cartView === 'done' || (!hasNew && !hasPrev);
    cartSumPrev.hidden = !(hasNew && hasPrev);
    cartSumNew.hidden = !(hasNew && hasPrev);
    cartPrevTotal.textContent = fmt(prevTotal);
    cartNewTotal.textContent = fmt(newTotal);
    cartTotalLabel.textContent = hasPrev ? 'Table total' : 'Total';
    cartSend.hidden = !hasNew;
    cartBrowse.hidden = hasNew;
    if (!cartSend.disabled) cartSendLabel.textContent = sendLabelText();

    cartListEl.innerHTML = '';
    cart.forEach((line, i) => {
      const hasAddons = line.addons && line.addons.length > 0;
      const li = document.createElement('li');
      li.className = 'cart__item';
      const media = line.img
        ? `<img src="${line.img}" alt="" loading="lazy">`
        : `<span class="cart__item__avatar">${line.name.trim().charAt(0).toUpperCase()}</span>`;
      const unit = lineUnitPrice(line);
      const safeName = escapeHtml(line.name);
      const addonNodes = hasAddons
        ? `<ul class="cart__addons" aria-label="Add-ons on this ${safeName}">
            ${line.addons.map((a) => `
            <li class="cart__addons__node">
              <span class="cart__addons__name">${escapeHtml(a.name)}</span>
              <span class="cart__addons__price">+${fmt(a.price)}</span>
            </li>`).join('')}
          </ul>`
        : '';
      const noteHtml = line.note
        ? `<p class="cart__note">"${escapeHtml(line.note)}"</p>`
        : '';
      li.innerHTML = `
        <div class="cart__item__top">
          <span class="cart__item__media">${media}</span>
          <span class="cart__item__name">${safeName}</span>
          <button type="button" class="cart__remove" aria-label="Remove ${safeName}">
            <svg aria-hidden="true"><use href="#i-trash" /></svg>
          </button>
        </div>
        ${addonNodes}
        ${noteHtml}
        <div class="cart__item__bottom">
          <span class="cart__item__unit">${fmt(unit)} IQD each</span>
          <div class="cart__item__right">
            <div class="cart__qty">
              <button type="button" class="cart__qty--minus" aria-label="One fewer ${safeName}">
                <svg aria-hidden="true"><use href="#i-minus" /></svg>
              </button>
              <span>${line.qty}</span>
              <button type="button" class="cart__qty--plus" aria-label="One more ${safeName}">
                <svg aria-hidden="true"><use href="#i-plus" /></svg>
              </button>
            </div>
            <span class="cart__line">${fmt(unit * line.qty)}</span>
          </div>
        </div>`;
      $('.cart__qty--minus', li).addEventListener('click', () => setQty(i, cart[i].qty - 1));
      $('.cart__qty--plus', li).addEventListener('click', () => setQty(i, cart[i].qty + 1));
      $('.cart__remove', li).addEventListener('click', () => setQty(i, 0));
      cartListEl.appendChild(li);
    });

    cartTotalEl.firstChild.textContent = `${fmt(grand)} `;
  }

  /* ---------- add-ons popup ----------
     Tapping + on a drink doesn't drop it straight in the cart — it opens
     "add anything else to your drink?" first, sourced live off the
     Add-ons section's own price list so the two never drift apart. */

  // which add-ons make sense on which drinks, per the owner's spec. A
  // section missing from this map (manual, signature, desserts, bottled,
  // add-ons itself) gets no prompt at all — every item in it is either
  // fully covered by ITEM_ADDONS below, or has nothing that applies.
  // Names must match the #addons list in index.html exactly.
  const SECTION_ADDONS = {
    classic: ['Extra Espresso Shot', 'Extra Milk'],
    iced:    ['Extra Espresso Shot', 'Extra Milk', 'Flavor Syrup', 'Cold Foam'],
    matcha:  ['Extra Milk', 'Flavor Syrup', 'Cold Foam', 'Ice Cream Scoop'],
    frappe:  ['Extra Espresso Shot', 'Extra Milk', 'Flavor Syrup', 'Cold Foam', 'Ice Cream Scoop'],
    // no Extra Milk — a thinner milkshake is a prep request, not a paid add-on
    shakes:  ['Flavor Syrup', 'Cold Foam', 'Ice Cream Scoop'],
    // no Flavor Syrup — these are specific flavors already, not a base to re-flavor
    milk:    ['Extra Milk', 'Cold Foam', 'Ice Cream Scoop'],
    fresh:   ['Flavor Syrup'],
    // Cold Foam Signatures (section id "signature") isn't in this map at
    // all — they're café-designed drinks that already include cold foam,
    // so none of the 5 add-ons apply.
  };

  // per-drink overrides — take priority over the section default above.
  // An item listed here (even with an empty array) fully replaces whatever
  // its section would otherwise offer, for drinks that don't fit their
  // section's norm (e.g. an Iced Americano is black, so no Extra Milk;
  // a Cold Brew isn't espresso-based, so no Extra Espresso Shot; a plain
  // Espresso/Turkish Coffee is intentionally prepared as-is).
  const ITEM_ADDONS = {
    'Espresso': [],
    'Double Espresso': [],
    'Macchiato': ['Extra Espresso Shot', 'Extra Milk'],
    'Cortado': ['Extra Espresso Shot', 'Extra Milk'],
    'Turkish Coffee': [],
    // these three keep Flavor Syrup — they're plain-ish bases worth flavoring
    'Cappuccino': ['Extra Espresso Shot', 'Extra Milk', 'Flavor Syrup'],
    'Latte': ['Extra Espresso Shot', 'Extra Milk', 'Flavor Syrup'],
    'Spanish Latte': ['Extra Espresso Shot', 'Extra Milk', 'Flavor Syrup'],
    // Vanilla/Caramel Latte, Mocha, White Mocha fall through to the
    // "classic" section default (shot + milk, no syrup — already flavored)
    'V60': [],
    'Chemex': [],
    'Cold Brew': ['Extra Milk', 'Flavor Syrup', 'Cold Foam'],
    'Iced Americano': ['Extra Espresso Shot', 'Flavor Syrup', 'Cold Foam'],
    'Fresh Orange Juice': [],
  };

  const addonOverlay    = $('#addonOverlay');
  const addonModal      = $('#addonModal');
  const addonModalList  = $('#addonModalList');
  const addonModalDrink = $('#addonModalDrink');
  const addonCloseBtn   = $('#addonClose');
  const addonAddBtn     = $('#addonAddBtn');
  const addonAddTotalEl = $('#addonAddTotal');
  const addonNoteInput  = $('#addonNoteInput');

  // Add-ons carry a posId of their own: the POS sells them as ordinary
  // products, so "Cappuccino + Extra Shot" leaves here as two order lines even
  // though the guest sees one. The cashier sees both, and the total agrees.
  const addonDefs = $$('#addons .item').map((row) => {
    const nameEl = $('.item__name', row);
    const priceEl = $('.item__price', row);
    const price = priceEl ? parsePrice(priceEl.textContent) : NaN;
    return Number.isNaN(price) ? null : { name: cleanName(nameEl), price, posId: row.dataset.posId || null };
  }).filter(Boolean);

  let pendingItem = null;
  let selectedAddons = new Set();
  let currentAddonOptions = []; // addonDefs filtered to the pending item's section

  function selectedAddonsTotal() {
    let sum = 0;
    selectedAddons.forEach((i) => { sum += currentAddonOptions[i].price; });
    return sum;
  }

  function updateAddonAddLabel() {
    const extra = selectedAddonsTotal();
    addonAddTotalEl.textContent = extra > 0 ? ` · ${fmt(extra)} IQD` : '';
  }

  function renderAddonModalList() {
    addonModalList.innerHTML = '';
    currentAddonOptions.forEach((addon, i) => {
      const li = document.createElement('li');
      li.className = 'addon-modal__row';
      const id = `addon-opt-${i}`;
      li.innerHTML = `
        <label class="addon-modal__label" for="${id}">
          <input type="checkbox" id="${id}" class="addon-modal__check">
          <span class="addon-modal__name">${addon.name}</span>
          <span class="addon-modal__price">+${fmt(addon.price)} IQD</span>
        </label>`;
      const checkbox = $('input', li);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedAddons.add(i);
        else selectedAddons.delete(i);
        updateAddonAddLabel();
      });
      addonModalList.appendChild(li);
    });
    updateAddonAddLabel();
  }

  function openAddonModal(item, allowedNames) {
    pendingItem = item;
    selectedAddons = new Set();
    currentAddonOptions = addonDefs.filter((a) => allowedNames.includes(a.name));
    addonModalDrink.textContent = item.name;
    addonNoteInput.value = '';
    renderAddonModalList();
    addonOverlay.hidden = false;
    addonModal.hidden = false;
    document.body.classList.add('cart-open');
    requestAnimationFrame(() => {
      addonOverlay.classList.add('is-open');
      addonModal.classList.add('is-open');
    });
  }

  function closeAddonModal() {
    addonOverlay.classList.remove('is-open');
    addonModal.classList.remove('is-open');
    document.body.classList.remove('cart-open');
    window.setTimeout(() => {
      addonOverlay.hidden = true;
      addonModal.hidden = true;
    }, 300);
    pendingItem = null;
  }

  /* Backing out of this modal adds nothing at all — not the add-ons, and not
   * the drink underneath them.
   *
   * Tapping + opens a question, and a question the guest never answered is not
   * an order. The old "no thanks" button dropped the plain drink in the cart,
   * which meant the two dismissal gestures every modal has — the backdrop and
   * Escape — quietly bought a coffee. A guest who taps outside to get out is
   * saying "forget it", and finding a drink they never confirmed on the bill
   * is the one mistake here that costs them money.
   *
   * Adding with nothing ticked is still one tap: that is what the Add button
   * does when no box is checked. */
  function cancelAddons() {
    closeAddonModal();
  }

  addonCloseBtn.addEventListener('click', cancelAddons);

  addonAddBtn.addEventListener('click', () => {
    if (pendingItem) {
      const chosenAddons = Array.from(selectedAddons).map((i) => ({
        name: currentAddonOptions[i].name,
        price: currentAddonOptions[i].price,
        posId: currentAddonOptions[i].posId,
      }));
      addToCart(pendingItem.name, pendingItem.price, pendingItem.img, chosenAddons, addonNoteInput.value, pendingItem.posId);
    }
    closeAddonModal();
  });

  // the backdrop and Escape are dismissals, and a dismissal is a cancel
  addonOverlay.addEventListener('click', cancelAddons);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !addonModal.hidden) cancelAddons();
  });

  // wire an "add" button onto every priced card/item already on the page —
  // reads the price (and photo, for cards) straight off what's printed, so
  // new menu items only ever need their HTML, never a JS change
  $$('.pcard').forEach((card) => {
    const nameEl = $('.pcard__name', card);
    if (!nameEl) return;

    const priceEl = $('.pcard__price', card);
    let price = priceEl ? parsePrice(priceEl.textContent) : NaN;

    if (Number.isNaN(price)) {
      // signature cards share one price, set once on the section itself
      const featureSec = card.closest('.sec--feature');
      const sharedPrice = featureSec ? $('.feature__price b', featureSec) : null;
      if (sharedPrice) price = parsePrice(sharedPrice.textContent);
    }
    if (Number.isNaN(price)) return;

    const name = cleanName(nameEl);
    const photoEl = $('.pcard__photo', card);
    const img = photoEl?.querySelector('img')?.getAttribute('src') || null;

    const sec = card.closest('.sec');
    const allowedAddonNames = ITEM_ADDONS[name] !== undefined
      ? ITEM_ADDONS[name]
      : (sec && SECTION_ADDONS[sec.id]) || [];
    const offersAddons = addonDefs.length > 0 && allowedAddonNames.length > 0;

    const posId = card.dataset.posId || null;

    // No posId means the POS has no product for this, so an order carrying it
    // would be refused at send time. Offering a button that leads to "not
    // available" at checkout is worse than offering none: the guest has
    // already decided by then. The item still reads normally on the page.
    if (canOrder && !posId) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pcard__add';
    btn.setAttribute('aria-label', `Add ${name} to your order`);
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-plus" /></svg>';
    btn.addEventListener('click', () => {
      // priceOf, not the `price` captured when this button was built: the live
      // sync lands after wiring, and a stale closure would put the printed
      // price in the cart while the POS charged the real one.
      const p = priceOf(card, price);
      if (offersAddons) openAddonModal({ name, price: p, img, posId }, allowedAddonNames);
      else addToCart(name, p, img, [], '', posId);
    });
    // anchored to the photo tile itself (not the whole card) so it can
    // never end up sitting over the name/price text below it
    (photoEl || card).appendChild(btn);
  });

  /*
   * Give a list row its add button.
   *
   * Split out because the live sync calls it too. A row printed with a blank
   * "TBD" price gets no button here, but the POS may well know the price -- and
   * an item the till can sell that the menu refuses to add is just lost orders.
   * So the sync calls this again once a real price arrives.
   */
  function wireItemAdd(row) {
    if (row.closest('#addons')) return;     // chosen through the drink popup
    if ($('.item__add', row)) return;       // already has one
    if (row.classList.contains('is-soldout') || row.classList.contains('is-unavailable')) return;

    const nameEl = $('.item__name', row);
    const priceEl = $('.item__price', row);
    if (!nameEl || !priceEl) return;

    const price = priceOf(row, parsePrice(priceEl.textContent));
    if (!Number.isFinite(price) || price <= 0) return; // still nothing to ring up

    const name = cleanName(nameEl);
    const posId = row.dataset.posId || null;
    if (canOrder && !posId) return;   // see the note in the pcard loop above

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item__add';
    btn.setAttribute('aria-label', `Add ${name} to your order`);
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-plus" /></svg>';
    btn.addEventListener('click', () => addToCart(name, priceOf(row, price), null, [], '', posId));
    row.appendChild(btn);
  }

  $$('.item').forEach(wireItemAdd);

  function openCart() {
    // the receipt is a one-time confirmation of a send, not a screen to come
    // back to — reopening always lands on the browse view, where the sent
    // order is still listed under "Already ordered"
    if (cartView !== 'cart') setCartView('cart');
    cartStatus.textContent = '';
    cartStatus.className = 'cart__status';
    cartOverlay.hidden = false;
    cartPanel.hidden = false;
    document.body.classList.add('cart-open');
    requestAnimationFrame(() => {
      cartOverlay.classList.add('is-open');
      cartPanel.classList.add('is-open');
    });
  }
  function closeCart() {
    cartOverlay.classList.remove('is-open');
    cartPanel.classList.remove('is-open');
    document.body.classList.remove('cart-open');
    window.setTimeout(() => {
      cartOverlay.hidden = true;
      cartPanel.hidden = true;
    }, 300);
  }

  cartBtn.addEventListener('click', openCart);
  cartCloseBtn.addEventListener('click', closeCart);
  cartOverlay.addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !cartPanel.hidden) closeCart();
  });

  /*
   * Turn the cart into what the POS accepts.
   *
   * Product ids, quantities, and the guest's note. No names, no prices, no
   * total: the POS prices every line from its own catalogue and ignores
   * anything else, which is what stops a guest editing the total in devtools
   * and being charged it.
   *
   * An add-on becomes its own line. The guest reads one cart row for
   * "Cappuccino + Extra Shot"; the counter gets two lines that sum to the
   * same money.
   */
  function collectOrderLines() {
    const lines = [];
    const missing = [];
    for (const l of cart) {
      if (!l.posId) { missing.push(l.name); continue; }
      const line = { productId: l.posId, quantity: l.qty };
      /* The special request rides on the drink, not on its add-ons.
       *
       * It has to be sent at all: the sent-orders list quotes the note back to
       * the guest, so leaving it out of the payload told them "no ice" had been
       * passed on while the kitchen ticket said nothing. A note that is shown
       * but not delivered is worse than no note field at all.
       *
       * `notes`, plural, because that is the field the till, the kitchen screen
       * and the receipt all read (see the POS's lib/orders-service.js). Putting
       * it on the add-on lines too would print the same sentence twice on one
       * ticket. */
      if (l.note) line.notes = l.note;
      lines.push(line);
      for (const a of (l.addons || [])) {
        if (!a.posId) { missing.push(a.name); continue; }
        // One add-on per drink, so the add-on quantity follows the drink's.
        lines.push({ productId: a.posId, quantity: l.qty });
      }
    }
    return { lines, missing };
  }

  /* Sends the finished order. Same-origin to this site's Worker, which adds
     the shared secret and forwards to the POS — see ORDER_ENDPOINT above. */
  async function sendOrderToPOS(payload) {
    const res = await fetch(ORDER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      // The POS writes guest-readable refusals -- "product sold out", "too
      // many orders waiting for this table". Showing its wording beats a
      // generic failure the guest can do nothing about.
      const err = new Error((body && body.error) || `POS responded ${res.status}`);
      err.status = res.status;
      err.posMessage = body && body.error;
      throw err;
    }
    return body || {};
  }

  cartSend.addEventListener('click', async () => {
    if (cart.length === 0) return;

    if (!canOrder) {
      cartStatus.textContent = 'Scan the QR code on your table to order.';
      cartStatus.className = 'cart__status cart__status--error';
      return;
    }

    const { lines, missing } = collectOrderLines();
    if (missing.length) {
      // Naming them beats "something went wrong": the guest can remove the
      // offending item and send the rest, instead of being stuck.
      cartStatus.textContent = `Not available to order right now: ${missing.join(', ')}. Please ask your server.`;
      cartStatus.className = 'cart__status cart__status--error';
      return;
    }
    if (!lines.length) return;

    const order = { t: QR_TOKEN, items: lines };

    cartSend.disabled = true;
    cartSendLabel.textContent = 'Placing your order…';
    cartStatus.textContent = '';
    cartStatus.className = 'cart__status';

    try {
      await sendOrderToPOS(order);

      // the cart empties into the record rather than just emptying: a guest
      // who taps "place order" and watches the list vanish has no way to
      // check what they actually asked for
      const record = { at: Date.now(), lines: cart.map(snapshotLine) };
      placed.push(record);
      savePlaced();
      cart = [];
      saveCart();

      cartStatus.textContent = '';
      cartStatus.className = 'cart__status';
      renderDone(record);
      setCartView('done');
      cartDone.focus();
    } catch (err) {
      cartStatus.textContent = err && err.posMessage
        ? err.posMessage
        : "Couldn't place the order — try again.";
      cartStatus.className = 'cart__status cart__status--error';
    } finally {
      cartSend.disabled = false;
      cartSendLabel.textContent = sendLabelText();
    }
  });

  /* The receipt for the order that just went through. Its own totals, not the
     table's: this screen answers "what did I just send", and the running bill
     is one tap away under "Already ordered". */
  function renderDone(record) {
    cartDoneList.innerHTML = record.lines.map(sentLineHtml).join('');
    cartDoneTotal.firstChild.textContent = `${fmt(linesTotal(record.lines))} `;
    cartDoneSub.textContent = TABLE_NUMBER != null
      ? `Sent to the counter — table ${TABLE_NUMBER}.`
      : 'Sent to the counter.';
  }

  // both "add more items" buttons mean the same thing: back to the menu, with
  // what was sent kept safe behind the cart button
  cartDoneMore.addEventListener('click', () => { setCartView('cart'); closeCart(); });
  cartBrowse.addEventListener('click', closeCart);

  renderCart();

  /* ---------- header photo: double-tap to swap the shot ----------
     Not persisted on purpose: header-cup.jpg is the default, so every
     fresh load starts there. dblclick alone is unreliable on touch, so
     the two taps are timed off pointerup and dblclick is only used to
     stop the browser selecting text on the second click. */

  const photo = $('.mhead__photo');
  const deco = $('.mhead__deco');

  if (photo && deco && photo.dataset.altSrc) {
    const SHOTS = [photo.getAttribute('src'), photo.dataset.altSrc];
    const GAP = 400;   // ms between taps
    const SLOP = 40;   // px the finger may drift

    // warm the cache so the first swap doesn't flash an empty frame
    const preload = new Image();
    preload.src = SHOTS[1];

    let shown = 0;
    let lastAt = 0, lastX = 0, lastY = 0, busy = false;

    function swap() {
      if (busy) return;
      busy = true;
      shown = shown ? 0 : 1;
      photo.style.opacity = '0';
      window.setTimeout(() => {
        photo.src = SHOTS[shown];
        photo.classList.toggle('mhead__photo--alt', shown === 1);
        photo.style.opacity = '';
        busy = false;
      }, 170);
    }

    deco.addEventListener('pointerup', (e) => {
      const near = Math.abs(e.clientX - lastX) < SLOP && Math.abs(e.clientY - lastY) < SLOP;
      if (e.timeStamp - lastAt < GAP && near) {
        lastAt = 0;
        swap();
      } else {
        lastAt = e.timeStamp;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    deco.addEventListener('dblclick', (e) => e.preventDefault());
  }

  /* ---------- live sync with the POS ----------
   *
   * The printed page is the design; the POS is the truth about money and
   * availability. On load we ask the Worker for this table's live catalogue and
   * reconcile the two:
   *
   *   - the table number, which only the QR token knows
   *   - prices, so a guest is never quoted one number and charged another
   *   - sold-out items, greyed and un-addable
   *
   * Keyed on data-pos-id, written into the page by scripts/map-posids.mjs.
   * Never on names: five Cold Foam Signatures differ by a single word, and a
   * near-miss there means the wrong drink at the counter.
   *
   * A failure here is quiet on purpose. The menu still reads correctly and the
   * guest can still order at printed prices; the POS re-prices every line on
   * arrival anyway, so the worst case is a surprise at the till rather than a
   * blank page.
   */
  async function syncWithPos() {
    if (!canOrder) return;

    let data;
    try {
      const res = await fetch(`${MENU_ENDPOINT}?t=${encodeURIComponent(QR_TOKEN)}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    if (!data || !Array.isArray(data.products)) return;

    if (data.table && data.table.number != null) {
      TABLE_NUMBER = data.table.number;
      cartTableNum.textContent = String(TABLE_NUMBER);
      cartTable.hidden = false;
    }

    const live = new Map();
    for (const p of data.products) if (p && p.id) live.set(p.id, p);

    // Happy hour is the POS's call, not this page's: it knows the schedule and
    // it is what will actually be charged.
    const effectivePrice = (p) => {
      if (data.happyHourActive && p.happyHourPrice != null && Number(p.happyHourPrice) < Number(p.price)) {
        return Number(p.happyHourPrice);
      }
      return Number(p.price);
    };

    const applyTo = (el, priceSel) => {
      const p = live.get(el.dataset.posId);
      if (!p) {
        // Tagged with an id the POS no longer has -- withdrawn item, or a
        // mapping that has gone stale. Treat as unavailable rather than
        // letting it fail at send time.
        el.classList.add('is-unavailable');
        el.querySelectorAll('.pcard__add, .item__add').forEach((b) => b.remove());
        return;
      }

      const price = effectivePrice(p);
      if (Number.isFinite(price) && price > 0) {
        el.dataset.price = String(price);
        const priceEl = el.querySelector(priceSel);
        // The currency unit sits in its own child on cards; replacing only the
        // leading number keeps "IQD" where the designer put it.
        if (priceEl) {
          const unit = priceEl.querySelector('span');
          priceEl.textContent = fmt(price) + (unit ? ' ' : '');
          if (unit) priceEl.appendChild(unit);
          priceEl.classList.remove('item__price--tbd');
        }
      }

      if (p.soldOut) {
        el.classList.add('is-soldout');
        el.querySelectorAll('.pcard__add, .item__add').forEach((b) => b.remove());
      } else if (el.classList.contains('item')) {
        // The POS supplied a price for something the printed page left as TBD.
        // No-ops when the row already has a button.
        wireItemAdd(el);
      }
    };

    $$('.pcard[data-pos-id]').forEach((el) => applyTo(el, '.pcard__price'));
    $$('.item[data-pos-id]').forEach((el) => applyTo(el, '.item__price'));

    // Add-on prices are read when the modal opens, so refreshing the shared
    // definitions is enough -- no need to rebuild anything on screen.
    for (const a of addonDefs) {
      const p = a.posId && live.get(a.posId);
      if (p) a.price = effectivePrice(p);
    }

    // A cart restored from localStorage can hold yesterday's prices, or an item
    // the cafe has since withdrawn. Re-price it against what just arrived so
    // the total the guest approves is the total they pay.
    let repriced = false;
    for (const l of cart) {
      const p = l.posId && live.get(l.posId);
      if (p) {
        const price = effectivePrice(p);
        if (Number.isFinite(price) && price > 0 && price !== l.price) { l.price = price; repriced = true; }
      }
      for (const a of (l.addons || [])) {
        const ap = a.posId && live.get(a.posId);
        if (ap) {
          const price = effectivePrice(ap);
          if (Number.isFinite(price) && price > 0 && price !== a.price) { a.price = price; repriced = true; }
        }
      }
    }
    if (repriced) { saveCart(); renderCart(); }
  }

  syncWithPos();
})();
