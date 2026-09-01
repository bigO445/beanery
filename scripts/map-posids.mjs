#!/usr/bin/env node
/**
 * scripts/map-posids.mjs — give every menu item its POS product id.
 *
 * WHY THIS EXISTS
 *
 * The POS refuses to take a price from the browser. Every line of a guest order
 * is priced from the POS's own catalogue, and the only thing it accepts to
 * identify an item is a `productId`. This site has no product ids: menu.json
 * carries names and prices, and menu/index.html is pre-rendered from it.
 *
 * So each item needs its POS id recorded once. This script does the matching by
 * name against the live catalogue, writes the result into both files, and — the
 * important part — prints everything it could NOT match so a human decides
 * those rather than the script guessing.
 *
 * After this runs, matching by name never happens again at runtime. The ids are
 * explicit in the files, so renaming an item on either side is safe.
 *
 * USAGE
 *
 *   node scripts/map-posids.mjs --token <qrToken>              # dry run, changes nothing
 *   node scripts/map-posids.mjs --token <qrToken> --write      # applies
 *   node scripts/map-posids.mjs --menu live-menu.json --write  # from a saved response
 *
 * The token is any table's qrToken from the POS's table-token.json — it only
 * selects which cafe's menu to read, and the response is the same public
 * catalogue a guest sees when they scan.
 *
 * By default it reads through the deployed Worker (https://beanery-cafe.com),
 * so it exercises the same path the menu does. Use --origin to point somewhere
 * else, or --menu to work from a file with no network at all.
 *
 * --write makes a .bak of both files first. .gitignore already excludes *.bak.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MENU_JSON = path.join(ROOT, 'menu', 'menu.json');
const MENU_HTML = path.join(ROOT, 'menu', 'index.html');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(tok);
  }
  return args;
}

function die(msg) {
  console.error('Error: ' + msg);
  process.exit(1);
}

/*
 * Two names are the same item if they read the same to a person: case,
 * punctuation, accents and doubled spaces are noise. Deliberately conservative
 * — no fuzzy distance, no substring matching. "Latte" must not quietly match
 * "Caramel Latte", and with five Cold Foam Signatures differing by one word
 * that is a real risk, not a hypothetical one.
 */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function loadPosMenu(args) {
  if (args.menu && args.menu !== true) {
    const raw = fs.readFileSync(path.resolve(args.menu), 'utf8');
    return JSON.parse(raw);
  }
  const token = args.token;
  if (!token || token === true) {
    die('need --token <qrToken> (any table from the POS table-token.json), or --menu <file>');
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    die('that does not look like a qrToken — expected 64 hex characters');
  }
  const origin = (args.origin && args.origin !== true) ? String(args.origin).replace(/\/$/, '') : 'https://beanery-cafe.com';
  const url = `${origin}/api/menu?t=${token}`;
  console.log(`Reading live menu: ${origin}/api/menu`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    die(`live menu request failed: ${res.status}. ` +
        (res.status === 404
          ? 'A 404 here means the token is unknown, QR ordering is off for that table, or the Worker cannot reach the POS.'
          : ''));
  }
  return res.json();
}

function buildIndex(posMenu) {
  const byName = new Map();
  const collisions = new Map();
  for (const p of posMenu.products || []) {
    // Both the display name and the English name are worth indexing: the site
    // is written in English and the POS may carry either.
    for (const candidate of [p.name, p.nameEnglish]) {
      const key = norm(candidate);
      if (!key) continue;
      if (byName.has(key) && byName.get(key).id !== p.id) {
        // Two different POS products answering to one name. Picking either
        // blind would be a coin flip that shows up later as the wrong drink --
        // but the section they each sit in usually settles it. See resolve().
        if (!collisions.has(key)) collisions.set(key, [byName.get(key)]);
        collisions.get(key).push(p);
        continue;
      }
      byName.set(key, p);
    }
  }

  // POS category id -> its display name, so a collision can be settled by
  // where each candidate lives rather than by guessing.
  const catName = new Map();
  for (const c of posMenu.categories || []) if (c && c.id) catName.set(c.id, c.name || '');

  return { byName, collisions, catName };
}

// Tighter than norm(): drops separators entirely, so the site's section id
// "addons" and the POS category "Add-ons" collapse to the same token.
function slug(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/*
 * Which POS product is this menu item?
 *
 * Returns { product } or { why } — never a guess.
 *
 * The interesting case is a name that two POS products share. "Ice Cream
 * Scoop" is sold both as a dessert and as an add-on: same name, same price,
 * genuinely two different products. What separates them is the section, and
 * both sides record one, so a collision whose candidates sit in different
 * categories is decidable. Only a collision that survives that is a real
 * ambiguity worth a human's attention.
 */
function resolve(item, section, index) {
  const key = norm(item.name);
  const candidates = index.collisions.get(key);

  if (!candidates) {
    const hit = index.byName.get(key);
    return hit ? { product: hit } : { why: 'no POS product with this name' };
  }

  // De-duplicate by id first. A product is indexed under both `name` and
  // `nameEnglish`, so when those are equal -- which is the normal case for an
  // English-only menu -- it lands in the collision list twice and a perfectly
  // decidable pair looks like an ambiguous one.
  const seen = new Set();
  const unique = candidates.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  const want = [slug(section.id), slug(section.title)].filter(Boolean);
  const inSection = unique.filter((p) => {
    const cat = slug(index.catName.get(p.category) || p.category || '');
    return cat && want.some((w) => cat === w || cat.endsWith(w) || w.endsWith(cat));
  });

  // One real candidate after de-duplication is not a collision at all.
  if (unique.length === 1) return { product: unique[0] };
  if (inSection.length === 1) return { product: inSection[0], viaSection: true };
  return {
    why: inSection.length === 0
      ? `${unique.length} POS products share this name, none in a matching category`
      : `${inSection.length} POS products share this name in this category`
  };
}

/*
 * Pull the visible name out of an item block. The markup nests spans — the
 * "New" ribbon among them — so tags are stripped rather than the name being
 * read with a single greedy capture.
 */
function textOf(html) {
  return html
    // Any element carrying class="new", not just a span: the ribbon is a <b>
    // in the pcard markup. The site's own menu.js strips these with a DOM
    // selector, which is tag-agnostic, so a tag-specific regex here disagreed
    // with it for exactly one item ("Golden Lemon") and left it untaggable.
    .replace(/<(b|span|i|em|small)[^>]*class="[^"]*\bnew\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function main() {
  return (async () => {
    const args = parseArgs(process.argv);
    const write = args.write === true;

    const posMenu = await loadPosMenu(args);
    const products = posMenu.products || [];
    if (!products.length) die('the POS returned an empty catalogue — nothing to map');
    console.log(`POS catalogue: ${products.length} products`);

    const index = buildIndex(posMenu);

    // ── menu.json ───────────────────────────────────────────────────────
    const menu = JSON.parse(fs.readFileSync(MENU_JSON, 'utf8'));
    const matched = [];
    const unmatched = [];
    const priceDrift = [];
    const bySection = [];
    const usedIds = new Set();

    for (const section of menu.sections || []) {
      for (const item of section.items || []) {
        const { product: hit, why, viaSection } = resolve(item, section, index);
        if (!hit) {
          // An id already in the file wins over "could not match". That is how
          // a hand-resolved item survives a re-run instead of being reported
          // as broken every time.
          if (item.posId) {
            usedIds.add(item.posId);
            matched.push({ section: section.id, name: item.name, posId: item.posId, byHand: true });
          } else {
            unmatched.push({ section: section.id, name: item.name, why });
          }
          continue;
        }
        item.posId = hit.id;
        usedIds.add(hit.id);
        matched.push({ section: section.id, name: item.name, posId: hit.id });
        if (viaSection) bySection.push(`${section.id}/${item.name}`);

        // Not fixed here on purpose. A price that disagrees is a decision — the
        // POS is what the guest will actually be charged, so a difference means
        // either the printed menu or the till is wrong, and someone has to say
        // which.
        if (item.price !== undefined && Number(hit.price) !== Number(item.price)) {
          priceDrift.push({ name: item.name, site: item.price, pos: hit.price });
        }
      }
    }

    // ── menu/index.html ─────────────────────────────────────────────────
    let html = fs.readFileSync(MENU_HTML, 'utf8');

    /*
     * Keyed by section AND name, never by name alone.
     *
     * "Ice Cream Scoop" exists twice -- once under Desserts, once under
     * Add-ons -- as two genuinely different POS products. A name-only map
     * collapses them, last write wins, and the dessert row silently gets the
     * add-on's id: the wrong product on the kitchen ticket, and for any
     * colliding pair whose prices differ, the wrong money too.
     *
     * The page is scanned section by section for the same reason. The section
     * ids in this HTML and in menu.json are the same thirteen, and sections do
     * not nest, so the scoping is exact rather than approximate.
     */
    const posIdAt = new Map(matched.map((m) => [m.section + '|' + norm(m.name), m.posId]));
    let injected = 0;
    const untagged = [];

    const inject = (sectionId, openTag, block, nameClass) => {
      const nameMatch = block.match(new RegExp(`class="${nameClass}"[^>]*>([\\s\\S]*?)<\\/(?:span|h3)>`, 'i'));
      if (!nameMatch) { untagged.push('(no name found in block)'); return openTag; }
      const shown = textOf(nameMatch[1]);
      const posId = posIdAt.get(sectionId + '|' + norm(shown));
      // A NAMED miss, not a counter. An item that matched in menu.json but not
      // in the HTML gets a posId in one file and no data-pos-id in the other,
      // so it is unorderable for a reason nothing on screen explains -- which
      // is exactly the bug a silent `skipped++` hides.
      if (!posId) { untagged.push(shown); return openTag; }
      injected++;
      // Re-running must not stack duplicate attributes.
      const cleaned = openTag.replace(/\s+data-pos-id="[^"]*"/g, '');
      return cleaned.replace(/>$/, ` data-pos-id="${posId}">`);
    };

    html = html.replace(
      /(<section\b[^>]*\bid="([a-z0-9-]+)"[^>]*>)([\s\S]*?)(<\/section>)/gi,
      (full, secOpen, secId, body, secClose) => {
        let out = body.replace(
          /(<li class="item"[^>]*>)([\s\S]*?)<\/li>/g,
          (f, openTag, b) => inject(secId, openTag, b, 'item__name') + b + '</li>'
        );
        out = out.replace(
          /(<article class="pcard"[^>]*>)([\s\S]*?)<\/article>/g,
          (f, openTag, b) => inject(secId, openTag, b, 'pcard__name') + b + '</article>'
        );
        return secOpen + out + secClose;
      }
    );

    // ── report ──────────────────────────────────────────────────────────
    console.log('');
    console.log(`Matched      ${matched.length} / ${matched.length + unmatched.length} menu items`);
    console.log(`HTML tagged  ${injected} elements`);
    if (bySection.length) {
      console.log('');
      console.log(`Settled by section (${bySection.length}) — same name in the POS, different category:`);
      for (const n of bySection) console.log(`  ${n}`);
    }
    const byHand = matched.filter((m) => m.byHand);
    if (byHand.length) {
      console.log('');
      console.log(`Kept from the file (${byHand.length}) — posId set by hand, left alone:`);
      for (const m of byHand) console.log(`  ${m.section}/${m.name}  ->  ${m.posId}`);
    }

    // Items unmatched above are expected to be untagged; anything else here is
    // the two files disagreeing about a name, which is worth shouting about.
    const expectedUntagged = new Set(unmatched.map((u) => norm(u.name)));
    const surprising = untagged.filter((n) => !expectedUntagged.has(norm(n)));
    if (surprising.length) {
      console.log('');
      console.log(`NOT TAGGED IN HTML (${surprising.length}) -- matched in menu.json but the`);
      console.log('page spells them differently, so they would be unorderable:');
      for (const n of surprising) console.log(`  ${n}`);
    }

    if (priceDrift.length) {
      console.log('');
      console.log(`PRICE DISAGREEMENTS (${priceDrift.length}) — the POS wins at checkout:`);
      for (const d of priceDrift) {
        console.log(`  ${d.name.padEnd(32)} site ${String(d.site).padStart(7)}   POS ${String(d.pos).padStart(7)}`);
      }
      console.log('  Fix these in menu.json or in the POS. A guest reading one price');
      console.log('  and being charged the other is the complaint this catches.');
    }

    if (unmatched.length) {
      console.log('');
      console.log(`UNMATCHED (${unmatched.length}) — these cannot be ordered until they have a posId:`);
      for (const u of unmatched) console.log(`  ${(u.section + '/' + u.name).padEnd(44)} ${u.why}`);
      console.log('  Add "posId": "<id>" by hand in menu.json, or rename so the two sides agree.');
    }

    const orphans = products.filter((p) => !usedIds.has(p.id) && !p.soldOut);
    if (orphans.length) {
      console.log('');
      console.log(`IN THE POS BUT NOT ON THIS SITE (${orphans.length}):`);
      for (const p of orphans.slice(0, 40)) console.log(`  ${p.name}`);
      if (orphans.length > 40) console.log(`  ... and ${orphans.length - 40} more`);
    }

    if (!write) {
      console.log('');
      console.log('Dry run — nothing written. Re-run with --write to apply.');
      return;
    }

    fs.copyFileSync(MENU_JSON, MENU_JSON + '.bak');
    fs.copyFileSync(MENU_HTML, MENU_HTML + '.bak');
    fs.writeFileSync(MENU_JSON, JSON.stringify(menu, null, 2) + '\n');
    fs.writeFileSync(MENU_HTML, html);
    console.log('');
    console.log('Written. Backups at menu/menu.json.bak and menu/index.html.bak');
    if (unmatched.length) {
      console.log(`${unmatched.length} item(s) still have no posId — they will show as unavailable to order.`);
    }
  })();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
