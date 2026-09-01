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

  // Where the finished order gets POSTed. Wiring this up to the real POS
  // (endpoint, auth, register/table selection, retries) is the backend's
  // job — this file's responsibility ends at handing the order JSON off.
  const POS_ENDPOINT = '/pos/order';

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

  const SEND_LABEL_DEFAULT = cartSendLabel.textContent;

  // the table this menu was opened for — printed on the QR code as
  // e.g. /?table=12 — read once; it doesn't change for the life of the page
  const TABLE_NUMBER = new URLSearchParams(window.location.search).get('table');
  if (TABLE_NUMBER) {
    cartTableNum.textContent = TABLE_NUMBER;
    cartTable.hidden = false;
  }

  const parsePrice = (text) => {
    const digits = (text || '').replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : NaN;
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

  function addToCart(name, price, img, addons, note) {
    const addonList = addons && addons.length ? addons : [];
    const noteText = (note || '').trim();
    const key = addonsKey(addonList);
    // a written note is as distinguishing as the add-on set — two lines
    // only merge (qty++) when the drink, its add-ons, AND its note all match
    const line = cart.find((l) => l.name === name && l.price === price
      && addonsKey(l.addons) === key && (l.note || '') === noteText);
    if (line) line.qty += 1;
    else cart.push({ name, price, qty: 1, img: img || null, addons: addonList, note: noteText });
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

  function renderCart() {
    const count = cartCount();
    const total = cartTotal();
    const isEmpty = cart.length === 0;

    cartBadge.hidden = isEmpty;
    cartBadge.textContent = String(count);

    cartBarLabel.textContent = isEmpty ? 'Tap to order' : 'View order';
    cartBarTotalEl.hidden = isEmpty;
    cartBarTotalEl.textContent = `${fmt(total)} IQD`;
    cartBtn.classList.toggle('cartbar--invite', isEmpty);

    cartEmpty.hidden = cart.length > 0;
    cartFoot.hidden = cart.length === 0;
    cartCountLabel.textContent = cart.length === 0
      ? 'Your cart is empty'
      : `${count} ${count === 1 ? 'item' : 'items'}`;

    cartListEl.innerHTML = '';
    cart.forEach((line, i) => {
      const hasAddons = line.addons && line.addons.length > 0;
      const li = document.createElement('li');
      li.className = 'cart__item';
      const media = line.img
        ? `<img src="${line.img}" alt="" loading="lazy">`
        : `<span class="cart__item__avatar">${line.name.trim().charAt(0).toUpperCase()}</span>`;
      const unit = lineUnitPrice(line);
      const addonNodes = hasAddons
        ? `<ul class="cart__addons" aria-label="Add-ons on this ${line.name}">
            ${line.addons.map((a) => `
            <li class="cart__addons__node">
              <span class="cart__addons__name">${a.name}</span>
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
          <span class="cart__item__name">${line.name}</span>
          <button type="button" class="cart__remove" aria-label="Remove ${line.name}">
            <svg aria-hidden="true"><use href="#i-trash" /></svg>
          </button>
        </div>
        ${addonNodes}
        ${noteHtml}
        <div class="cart__item__bottom">
          <span class="cart__item__unit">${fmt(unit)} IQD each</span>
          <div class="cart__item__right">
            <div class="cart__qty">
              <button type="button" class="cart__qty--minus" aria-label="One fewer ${line.name}">
                <svg aria-hidden="true"><use href="#i-minus" /></svg>
              </button>
              <span>${line.qty}</span>
              <button type="button" class="cart__qty--plus" aria-label="One more ${line.name}">
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

    cartTotalEl.firstChild.textContent = `${fmt(total)} `;
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
  const addonSkipBtn    = $('#addonSkip');
  const addonAddBtn     = $('#addonAddBtn');
  const addonAddTotalEl = $('#addonAddTotal');
  const addonNoteInput  = $('#addonNoteInput');

  const addonDefs = $$('#addons .item').map((row) => {
    const nameEl = $('.item__name', row);
    const priceEl = $('.item__price', row);
    const price = priceEl ? parsePrice(priceEl.textContent) : NaN;
    return Number.isNaN(price) ? null : { name: cleanName(nameEl), price };
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

  // "no thanks" declines the listed add-ons specifically — a typed note
  // still rides along, since it's a separate signal from the checkboxes
  function skipAddons() {
    if (pendingItem) {
      addToCart(pendingItem.name, pendingItem.price, pendingItem.img, [], addonNoteInput.value);
    }
    closeAddonModal();
  }

  addonSkipBtn.addEventListener('click', skipAddons);

  addonAddBtn.addEventListener('click', () => {
    if (pendingItem) {
      const chosenAddons = Array.from(selectedAddons).map((i) => ({
        name: currentAddonOptions[i].name,
        price: currentAddonOptions[i].price,
      }));
      addToCart(pendingItem.name, pendingItem.price, pendingItem.img, chosenAddons, addonNoteInput.value);
    }
    closeAddonModal();
  });

  // dismissing without an explicit choice still has to land on one of the
  // two documented outcomes — treat it the same as "no thanks"
  addonOverlay.addEventListener('click', skipAddons);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !addonModal.hidden) skipAddons();
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

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pcard__add';
    btn.setAttribute('aria-label', `Add ${name} to your order`);
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-plus" /></svg>';
    btn.addEventListener('click', () => {
      if (offersAddons) openAddonModal({ name, price, img }, allowedAddonNames);
      else addToCart(name, price, img);
    });
    // anchored to the photo tile itself (not the whole card) so it can
    // never end up sitting over the name/price text below it
    (photoEl || card).appendChild(btn);
  });

  $$('.item').forEach((row) => {
    if (row.closest('#addons')) return; // chosen through the drink popup, not on their own

    const nameEl = $('.item__name', row);
    const priceEl = $('.item__price', row);
    if (!nameEl || !priceEl) return;

    const price = parsePrice(priceEl.textContent);
    if (Number.isNaN(price)) return; // blank/TBD price — nothing to ring up yet

    const name = cleanName(nameEl);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item__add';
    btn.setAttribute('aria-label', `Add ${name} to your order`);
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-plus" /></svg>';
    btn.addEventListener('click', () => addToCart(name, price));
    row.appendChild(btn);
  });

  function openCart() {
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

  /* Sends the finished order to the POS. This is the one place that talks
     to the POS — everything after it (accepting the order, printing a
     ticket, the register, etc.) is the backend's side to build. Point
     POS_ENDPOINT at the real integration URL when it exists. */
  async function sendOrderToPOS(order) {
    const res = await fetch(POS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    if (!res.ok) throw new Error(`POS responded ${res.status}`);
    return res.json().catch(() => ({}));
  }

  cartSend.addEventListener('click', async () => {
    if (cart.length === 0) return;

    const order = {
      table: TABLE_NUMBER || null,
      items: cart.map((l) => ({
        name: l.name,
        price: l.price,
        qty: l.qty,
        ...(l.addons && l.addons.length ? { addons: l.addons } : {}),
        ...(l.note ? { note: l.note } : {}),
      })),
      total: cartTotal(),
      currency: 'IQD',
      createdAt: new Date().toISOString(),
    };

    cartSend.disabled = true;
    cartSendLabel.textContent = 'Placing your order…';
    cartStatus.textContent = '';
    cartStatus.className = 'cart__status';

    try {
      await sendOrderToPOS(order);
      cartStatus.textContent = 'Order placed — the counter has it.';
      cartStatus.className = 'cart__status cart__status--ok';
      cart = [];
      saveCart();
      renderCart();
      window.setTimeout(closeCart, 1400);
    } catch (err) {
      cartStatus.textContent = "Couldn't place the order — try again.";
      cartStatus.className = 'cart__status cart__status--error';
    } finally {
      cartSend.disabled = false;
      cartSendLabel.textContent = SEND_LABEL_DEFAULT;
    }
  });

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
})();
