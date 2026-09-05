/* ═══════════════════════════════════════════════════════════════════
   BEANERY — behaviour

   Three small jobs. Nothing here is load-bearing: with JavaScript off
   the page is complete, the hours read as a plain statement, and every
   revealed element is already visible (see the `.js` guard in the
   stylesheet).
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;


  /* ── Copyright year ───────────────────────────────────────────── */

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());




  /* ── The deck ───────────────────────────────────────────────────
     Five cards on a turntable, THREE of them ever visible: the one in
     front and one peeking each side. Anything further round sits at
     PARKED, which is opacity 0 and pointer-events none.

     Nothing here runs per frame. One transform is written per card
     whenever the deck moves, and the browser eases it home — that is
     why it settles cleanly instead of drifting.
     ─────────────────────────────────────────────────────────────── */

  var deck = document.getElementById("deck");

  if (deck) {
    var stage   = deck.parentNode;
    var dotsBox = document.getElementById("dots");

    var all  = Array.prototype.slice.call(deck.querySelectorAll(".dcard"));
    var live = all.slice();          // what the current filter leaves in play

    /* Slot by distance from the front. `x` is a share of the card's own
       width; x and the rotation are mirrored for the cards on the left.

       TWO ENTRIES ONLY — index 0 is the front, index 1 is the pair
       either side. Distance 2 and beyond falls through to PARKED, so
       the deck never shows more than centre + left + right.

       Two arrangements: a tight fan on a phone, a wider one once there
       is room, because 78% of a card's width is a peek on a 320px
       screen and a shove on a 1200px one. */
    var FAN = [
      { x:   0, y:  0, r:  0, s: 1,    z: 40, o: 1 },
      { x:  52, y:  4, r:  6, s: 0.86, z: 24, o: 1 }
    ];
    /* On a wide screen the deck is no longer a fan — it is three cards
       standing side by side, which is what the redesign asks for. x is a
       share of the card's own width, so 106 puts the neighbours' centres
       just past one full card away and leaves a ~27px gutter instead of
       an overlap. Rotation drops to 0: tilted cards read as a turntable,
       flat ones read as a row, and only one of those is the intent.

       The arrows had to move out of the way for this — at this spread
       the side cards land exactly where the flanking buttons used to
       be, so .stage restacks them underneath on the same breakpoint.
       Change one of these without the other and they collide. */
    var ROW = [
      { x:   0, y: -3, r:  0, s: 1,    z: 40, o: 1 },
      { x: 104, y:  4, r:  0, s: 0.90, z: 24, o: 1 }
    ];
    var PARKED = { x: 96, y: 9, r: 8, s: 0.74, z: 4, o: 0 };

    /* Raised from 900px when ROW became a real three-card row. Three
       290px cards plus their gutters need ~884px of clear width; at
       900px the page only has ~819px between the gutters, so the outer
       two got shaved by .counter's overflow. Below this the fan still
       overlaps them, which is what a narrow screen wants anyway.

       styles.css restacks the arrows at this same 1100px — the two are
       a pair. */
    var wide = window.matchMedia("(min-width: 1100px)");
    var SLOT = wide.matches ? ROW : FAN;

    var at = parseInt(deck.getAttribute("data-start"), 10) || 0;

    /* Shortest signed distance from card i to the front, wrapping. */
    function delta(i) {
      var n = live.length;
      var d = (i - at) % n;
      if (d >  n / 2) d -= n;
      if (d < -n / 2) d += n;
      return d;
    }

    function render() {
      var n = live.length;

      all.forEach(function (c) {
        if (live.indexOf(c) === -1) {
          // filtered out entirely
          c.style.display = "none";
          c.setAttribute("aria-hidden", "true");
        } else {
          c.style.display = "";
        }
      });

      if (!n) return;

      live.forEach(function (c, i) {
        var d = delta(i);
        var a = d < 0 ? -d : d;
        var slot = a < SLOT.length ? SLOT[a] : PARKED;
        var w = d < 0 ? -1 : 1;

        c.style.transform =
          "translate(-50%,-50%)" +
          " translateX(" + (w * slot.x) + "%)" +
          " translateY(" + slot.y + "%)" +
          " rotate(" + (w * slot.r) + "deg)" +
          " scale(" + slot.s + ")";
        c.style.zIndex = String(slot.z);
        c.style.opacity = String(slot.o);
        c.style.pointerEvents = slot.o ? "auto" : "none";
        c.setAttribute("aria-hidden", slot.o ? "false" : "true");
        c.classList.toggle("is-front", d === 0);

        /* The arrow link only lives on the FRONT card.

           tap() below brings a side card round when you tap it, so on a
           side card the link and the tap want two different things — and
           navigation would win, carrying you off to the menu when you
           only meant to turn the deck. Off the front card the link is
           therefore inert: CSS drops pointer-events, and these two lines
           take it out of the tab order and off the accessibility tree so
           the keyboard and a screen reader agree with the mouse. */
        var go = c.querySelector(".dcard__go");
        if (go) {
          go.tabIndex = d === 0 ? 0 : -1;
          go.setAttribute("aria-hidden", d === 0 ? "false" : "true");
        }
      });

      if (dotsBox) {
        Array.prototype.forEach.call(dotsBox.children, function (b, i) {
          b.classList.toggle("is-on", i === at);
        });
      }
    }

    function goTo(i) {
      var n = live.length;
      if (!n) return;
      at = ((i % n) + n) % n;
      render();
    }
    function step(n) { goTo(at + n); }

    function buildDots() {
      if (!dotsBox) return;
      dotsBox.innerHTML = "";
      live.forEach(function (_, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.addEventListener("click", function () { taken(); goTo(i); });
        dotsBox.appendChild(b);
      });
    }

    /* ── The slow turn it takes on its own ─────────────────────────
       It stops for good the moment anyone touches it, and holds still
       while off screen, hovered, focused, or in a background tab. */
    var timer = null, onScreen = false, done = reduced;

    function play()  {
      if (done || timer || !onScreen) return;
      timer = setInterval(function () { step(1); }, 5500);
    }
    function pause() { clearInterval(timer); timer = null; }
    function taken() { done = true; pause(); }

    /* ── Drag ──────────────────────────────────────────────────────
       A swipe, not a scrub: the whole gesture is read and then one
       card is committed to. Nothing is written to the DOM until the
       pointer lifts, so a drag costs exactly what an arrow press
       costs. */
    var fromX = 0, fromY = 0, fromT = 0, tracking = false;

    deck.addEventListener("pointerdown", function (e) {
      tracking = true;
      fromX = e.clientX; fromY = e.clientY; fromT = Date.now();
      deck.classList.add("is-grabbing");
      taken();
    });

    // Bound to the window, so letting go outside the deck still counts.
    window.addEventListener("pointerup", function (e) {
      if (!tracking) return;
      tracking = false;
      deck.classList.remove("is-grabbing");

      var dx = e.clientX - fromX;
      var dy = e.clientY - fromY;
      // A flick needs less distance than a slow haul.
      var need = (Date.now() - fromT) < 300 ? 30 : 60;

      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > need) {
        step(dx < 0 ? 1 : -1);
        return;
      }
      // Barely moved? Treat it as a tap.
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) tap(e);
    });

    window.addEventListener("pointercancel", function () {
      tracking = false;
      deck.classList.remove("is-grabbing");
    });

    // A tap on a side card brings it round.
    function tap(e) {
      var card = e.target.closest && e.target.closest(".dcard");
      if (!card) return;
      var i = live.indexOf(card);
      if (i >= 0 && delta(i) !== 0) goTo(i);
    }

    /* ── Arrows, keyboard ──────────────────────────────────────────── */
    var prevBtn = document.getElementById("spinPrev");
    var nextBtn = document.getElementById("spinNext");
    if (prevBtn) prevBtn.addEventListener("click", function () { taken(); step(-1); });
    if (nextBtn) nextBtn.addEventListener("click", function () { taken(); step(1); });

    deck.setAttribute("tabindex", "0");
    deck.setAttribute("role", "group");
    deck.setAttribute("aria-roledescription", "carousel");
    deck.setAttribute("aria-label", "Drinks from the counter");
    deck.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft")  { e.preventDefault(); taken(); step(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); taken(); step(1); }
    });


    /* ── Wake / sleep ──────────────────────────────────────────────── */
    if (stage) {
      stage.addEventListener("mouseenter", pause);
      stage.addEventListener("mouseleave", play);
      stage.addEventListener("focusin", pause);
      stage.addEventListener("focusout", function (e) {
        if (!stage.contains(e.relatedTarget)) play();
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) pause(); else play();
    });

    /* Swap arrangements the moment the page crosses the width, rather
       than on a resize timer. */
    function relayout() { SLOT = wide.matches ? ROW : FAN; render(); }
    if (wide.addEventListener) wide.addEventListener("change", relayout);
    else if (wide.addListener) wide.addListener(relayout);

    // CSS keeps the plain wrapped row until this lands, so the deck is
    // the enhancement rather than the thing that breaks without JS.
    if (stage) stage.classList.add("is-live");
    buildDots();
    render();

    if ("IntersectionObserver" in window && stage) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) play(); else pause();
      }, { threshold: 0.35 }).observe(stage);
    } else {
      onScreen = true;
      play();
    }
  }


  /* ── Reveals ────────────────────────────────────────────────────
     Headings and ledes only. Under reduced-motion nothing is
     observed at all — the elements are simply shown.
     ─────────────────────────────────────────────────────────────── */

  var targets = document.querySelectorAll(".reveal");

  if (reduced || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(targets, function (el) { el.classList.add("in"); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.1 });

  Array.prototype.forEach.call(targets, function (el, i) {
    // A short stagger so a heading and its lede arrive in order
    // rather than as one block.
    el.style.transitionDelay = (i % 3) * 90 + "ms";
    io.observe(el);
  });

}());
