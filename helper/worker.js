// My Shelf helper: product search (with photos) and price checks across Australian stores.
// Runs on Cloudflare Workers. Open the worker's own address in a browser to see the test page.

const ALLOWED_ORIGINS = ["https://jessmakes-dev.github.io"];
const UA = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const STORES = [
  { id: "priceline", name: "Priceline", base: "https://www.priceline.com.au", pages: ["/search?q={q}", "/search?searchTerm={q}"] },
  { id: "chemist", name: "Chemist Warehouse", base: "https://www.chemistwarehouse.com.au", pages: ["/search?query={q}", "/search?searchtext={q}"] },
  { id: "adore", name: "Adore Beauty", base: "https://www.adorebeauty.com.au", pages: ["/results?q={q}", "/search?q={q}"] },
  { id: "lila", name: "Lila Beauty", base: "https://www.lilabeauty.com.au", shopify: true, pages: ["/search?q={q}&type=product"] },
  { id: "nudieglow", name: "Nudie Glow", base: "https://nudieglow.com", shopify: true, pages: [] },
  { id: "woolworths", name: "Woolworths", base: "https://www.woolworths.com.au", woolworths: true, pages: ["/shop/search/products?searchTerm={q}"] },
  { id: "coles", name: "Coles", base: "https://www.coles.com.au", pages: ["/search/products?q={q}"] },
  { id: "mecca", name: "Mecca", base: "https://www.mecca.com", pages: ["/en-au/search/?q={q}"] },
  { id: "sephora", name: "Sephora", base: "https://www.sephora.com.au", pages: ["/search?q={q}"] },
  { id: "amazon", name: "Amazon AU", base: "https://www.amazon.com.au", amazon: true, pages: ["/s?k={q}"] },
];
const SEARCH_STORES = ["lila", "nudieglow", "woolworths", "adore", "priceline", "chemist", "amazon"];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/" || url.pathname === "") return new Response(TEST_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/api/ping") return json({ ok: true, stores: STORES.map(s => s.name) }, cors);
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      if (url.pathname === "/api/search") {
        if (!q) return json({ error: "Missing search words" }, cors, 400);
        return json(await search(q), cors);
      }
      if (url.pathname === "/api/prices") {
        if (!q) return json({ error: "Missing product" }, cors, 400);
        return json(await prices(q), cors);
      }
      if (url.pathname === "/api/test") {
        if (!q) return json({ error: "Missing search words" }, cors, 400);
        const results = await Promise.all(STORES.map(s => checkStore(s, q, true)));
        return json({ q, results }, cors);
      }
      if (url.pathname === "/api/image") return image(url.searchParams.get("url"), cors);
      if (url.pathname === "/api/peek2") {
        if (!q) return new Response("Add ?q=product to the address", { headers: { "content-type": "text/plain" } });
        const parts = await Promise.all([peekContext(STORES.find(s => s.id === "chemist"), q), peekScripts(STORES.find(s => s.id === "priceline"), q)]);
        return new Response(parts.join("\n\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      }
      if (url.pathname === "/api/peek") {
        if (!q) return new Response("Add ?q=product to the address", { headers: { "content-type": "text/plain" } });
        const ids = (url.searchParams.get("stores") || "priceline,chemist,adore").split(",");
        const parts = await Promise.all(STORES.filter(s => ids.includes(s.id)).map(s => peek(s, q)));
        return new Response(parts.join("\n\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      }
      return json({ error: "Not found" }, cors, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, cors, 500);
    }
  },
};

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function get(url, accept) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: "follow",
      headers: { "User-Agent": UA, "Accept": accept || "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9" },
    });
    const text = await r.text();
    return { status: r.status, text, finalUrl: r.url };
  } finally { clearTimeout(t); }
}

/* ---------- Reading a store ---------- */
async function checkStore(store, q, verbose) {
  const tried = [];
  const enc = encodeURIComponent(q);
  try {
    if (store.shopify) {
      const u = store.base + "/search/suggest.json?q=" + enc + "&resources[type]=product&resources[limit]=10";
      const r = await get(u, "application/json");
      tried.push({ how: "shopify", status: r.status, bytes: r.text.length });
      if (r.status === 200) {
        const items = shopifyItems(store, r.text);
        if (items.length) return done(store, "ok", items, tried, verbose);
      }
    }
    if (store.woolworths) {
      const u = store.base + "/apis/ui/Search/products?searchTerm=" + enc + "&pageSize=12";
      const r = await get(u, "application/json");
      tried.push({ how: "woolworths-api", status: r.status, bytes: r.text.length });
      if (r.status === 200) {
        const items = woolworthsItems(store, r.text);
        if (items.length) return done(store, "ok", items, tried, verbose);
      }
    }
    for (const p of store.pages) {
      const r = await get(store.base + p.replace("{q}", enc));
      const blocked = r.status === 403 || r.status === 429 || r.status === 503 || /captcha|access denied|are you a robot|incapsula|cf-chl|px-captcha/i.test(r.text.slice(0, 5000));
      const items = r.status === 200 ? (store.amazon ? amazonItems(store, r.text) : pageItems(store, r.text)) : [];
      tried.push({ how: "page " + p, status: r.status, bytes: r.text.length, blocked, found: items.length });
      if (items.length) return done(store, "ok", items, tried, verbose);
      if (blocked) return done(store, "blocked", [], tried, verbose);
    }
    return done(store, "none", [], tried, verbose);
  } catch (e) {
    tried.push({ how: "error", message: String(e && e.message || e) });
    return done(store, "error", [], tried, verbose);
  }
}
function done(store, status, items, tried, verbose) {
  const out = { store: store.name, id: store.id, status, items };
  if (verbose) out.tried = tried;
  return out;
}

function decode(t) { return String(t || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim(); }
function amazonItems(store, html) {
  const out = [];
  const chunks = html.split('data-component-type="s-search-result"').slice(1, 16);
  for (const c of chunks) {
    if (/AdHolder|s-sponsored-label/.test(c.slice(0, 3000))) continue;
    const title = (c.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{4,})<\/span>/) || [])[1];
    const price = (c.match(/<span class="a-offscreen">\$?([\d,]+\.?\d*)<\/span>/) || [])[1];
    const was = (c.match(/a-text-price[^>]*>\s*<span class="a-offscreen">\$?([\d,]+\.?\d*)/) || [])[1];
    const img = (c.match(/<img[^>]*class="s-image"[^>]*src="([^"]+)"/) || c.match(/<img[^>]*src="([^"]+)"[^>]*class="s-image"/) || [])[1];
    const link = (c.match(/href="(\/[^"]*\/dp\/[A-Z0-9]{10}[^"]*)"/) || [])[1];
    const it = clean(store, { name: decode(title), brand: "", price: num(price), wasPrice: num(was), url: link ? decode(link).split("?")[0] : null, image: img });
    if (it) out.push(it);
  }
  return out;
}

async function peek(store, q) {
  const lines = ["== " + store.name + " =="];
  try {
    const r = await get(store.base + store.pages[0].replace("{q}", encodeURIComponent(q)));
    const h = r.text;
    lines.push("status " + r.status + ", " + h.length + " characters, ended at " + r.finalUrl);
    const urls = new Set();
    for (const m of h.matchAll(/https?:\/\/[^"'\s<>()\\]+/g)) {
      const u = m[0];
      if (/api|search|graphql|algolia|constructor|bloomreach|klevu|searchspring|coveo|unbxd|findify|attraqt|fredhopper|swiftype|elastic|typesense|product/i.test(u) && !/\.(png|jpe?g|svg|webp|gif|css|woff2?)(\?|$)/i.test(u)) urls.add(u.slice(0, 160));
      if (urls.size > 25) break;
    }
    lines.push("Interesting addresses:"); urls.forEach(u => lines.push("  " + u));
    const keys = new Set();
    for (const m of h.matchAll(/["']?(app(?:lication)?_?id|api_?key|search_?key|index_?name|client_?key|key|apiKey|appId|indexName|searchApiKey)["']?\s*[:=]\s*["']([A-Za-z0-9_\-.]{6,64})["']/gi)) { keys.add(m[1] + "=" + m[2]); if (keys.size > 20) break; }
    lines.push("Settings found:"); keys.forEach(k => lines.push("  " + k));
    const srcs = [...h.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]).slice(0, 15);
    lines.push("Scripts:"); srcs.forEach(s2 => lines.push("  " + s2.slice(0, 140)));
    const globals = [...new Set([...h.matchAll(/window\.([A-Za-z_$][\w$]{3,40})\s*=/g)].map(m => m[1]))].slice(0, 15);
    lines.push("Page data names: " + globals.join(", "));
    lines.push("Mentions: " + ["__NEXT_DATA__", "algolia", "constructorio", "bloomreach", "klevu", "searchspring", "graphql", "magento", "shopify", "salesforce", "hybris", "commercetools", "nuxt", "apollo"].filter(w => h.toLowerCase().includes(w.toLowerCase())).join(", "));
  } catch (e) { lines.push("error " + (e && e.message || e)); }
  return lines.join("\n");
}

async function peekContext(store, q) {
  const lines = ["== " + store.name + " (data) =="];
  try {
    const r = await get(store.base + store.pages[0].replace("{q}", encodeURIComponent(q)));
    const h = r.text, word = q.split(/\s+/).slice(-2).join(" ").toLowerCase(), low = h.toLowerCase();
    let from = 0, n = 0;
    while (n < 3) {
      const i = low.indexOf(word, from); if (i < 0) break;
      lines.push("--- near '" + word + "' at " + i + ":");
      lines.push(h.slice(Math.max(0, i - 450), i + 350).replace(/\s+/g, " "));
      from = i + 2000; n++;
    }
    const nd = h.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (nd) {
      try {
        const d = JSON.parse(nd[1]), pp = (d.props || {}).pageProps || {};
        lines.push("Page data sections: " + Object.keys(pp).join(", "));
        for (const k of Object.keys(pp)) { const v = pp[k]; if (v && typeof v === "object") lines.push("  " + k + ": " + Object.keys(v).slice(0, 15).join(", ")); }
        lines.push("Page data size: " + nd[1].length);
      } catch (e) { lines.push("Page data unreadable"); }
    } else lines.push("No page data block");
  } catch (e) { lines.push("error " + (e && e.message || e)); }
  return lines.join("\n");
}
async function peekScripts(store, q) {
  const lines = ["== " + store.name + " (scripts) =="];
  try {
    const r = await get(store.base + store.pages[0].replace("{q}", encodeURIComponent(q)));
    const srcs = [...r.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]).filter(s2 => /main|scripts|chunk/i.test(s2));
    for (const src of srcs.slice(0, 3)) {
      const u = absolute(store.base + "/", src);
      const js = await get(u, "*/*");
      lines.push("--- " + src + " (" + js.status + ", " + js.text.length + " characters)");
      const seen = new Set(); let n = 0;
      for (const m of js.text.matchAll(/api\.priceline\.com\.au|product-search|shopper-search|productSearch|searchProducts|\/search\?|clientId|client_id|siteId|organizations\/|x-api-key|apiKey|\/v\d\/[a-z-]*search/gi)) {
        const snip = js.text.slice(Math.max(0, m.index - 110), m.index + 130).replace(/\s+/g, " ");
        const key = snip.slice(90, 150); if (seen.has(key)) continue; seen.add(key);
        lines.push("  ..." + snip + "...");
        if (++n >= 14) break;
      }
    }
  } catch (e) { lines.push("error " + (e && e.message || e)); }
  return lines.join("\n");
}

function shopifyItems(store, text) {
  let d; try { d = JSON.parse(text); } catch { return []; }
  const list = (((d || {}).resources || {}).results || {}).products || [];
  return list.map(p => clean(store, {
    name: p.title, brand: p.vendor, price: num(p.price), wasPrice: num(p.compare_at_price_max || p.compare_at_price_min),
    url: p.url, image: p.image || (p.featured_image && p.featured_image.url), inStock: p.available !== false,
  })).filter(Boolean);
}
function woolworthsItems(store, text) {
  let d; try { d = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const group of d.Products || []) for (const p of group.Products || []) {
    out.push(clean(store, {
      name: p.DisplayName || p.Name, brand: p.Brand, price: num(p.Price), wasPrice: num(p.WasPrice),
      url: "/shop/productdetails/" + p.Stockcode + "/" + (p.UrlFriendlyName || ""), image: p.MediumImageFile || p.SmallImageFile, inStock: p.IsAvailable !== false,
    }));
  }
  return out.filter(Boolean);
}

function pageItems(store, html) {
  let items = [];
  // 1. Structured product data many shops include for Google
  const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ld) {
    try { walkLd(JSON.parse(m[1].trim()), items, store); } catch {}
  }
  if (items.length) return dedupe(items);
  // 2. Data the page carries for its own scripts
  const blobs = [];
  const nd = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nd) blobs.push(nd[1]);
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) blobs.push(m[1]);
  for (const m of html.matchAll(/window\.__[A-Z_]+__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) blobs.push(m[1]);
  for (const b of blobs) {
    try { walkData(JSON.parse(b), items, store, 0); } catch {}
    if (items.length >= 3) break;
  }
  return dedupe(items);
}
function walkLd(node, items, store) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => walkLd(n, items, store)); return; }
  if (typeof node !== "object") return;
  if (node["@graph"]) walkLd(node["@graph"], items, store);
  if (node.itemListElement) walkLd(node.itemListElement.map ? node.itemListElement.map(e => e.item || e) : node.itemListElement, items, store);
  const type = [].concat(node["@type"] || []).join(" ");
  if (/Product/i.test(type)) {
    const offers = [].concat(node.offers || [])[0] || {};
    const it = clean(store, {
      name: node.name, brand: node.brand && (node.brand.name || node.brand), price: num(offers.price || offers.lowPrice),
      url: node.url || offers.url, image: [].concat(node.image || [])[0], inStock: !/OutOfStock/i.test(offers.availability || ""),
    });
    if (it) items.push(it);
  }
}
const NAME_KEYS = ["name", "title", "productName", "displayName", "DisplayName", "product_name"];
const PRICE_KEYS = ["price", "salePrice", "currentPrice", "finalPrice", "sellPrice", "priceValue", "now", "nowPrice", "activePrice", "Price", "pricing"];
const WAS_KEYS = ["wasPrice", "listPrice", "rrp", "regularPrice", "originalPrice", "compareAtPrice", "WasPrice", "was"];
const IMG_KEYS = ["image", "imageUrl", "imageURL", "img", "thumbnail", "thumbnailUrl", "images", "media", "primaryImage", "MediumImageFile", "heroImage"];
const URL_KEYS = ["url", "pdpUrl", "productUrl", "link", "href", "seoUrl", "slug", "urlKey", "path", "canonicalUrl"];
const BRAND_KEYS = ["brand", "brandName", "manufacturer", "vendor", "Brand", "designer"];
function pick(o, keys) { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return null; }
function walkData(node, items, store, depth) {
  if (!node || depth > 14 || items.length > 40) return;
  if (Array.isArray(node)) { for (const n of node) walkData(n, items, store, depth + 1); return; }
  if (typeof node !== "object") return;
  const name = pick(node, NAME_KEYS), price = num(pick(node, PRICE_KEYS));
  if (typeof name === "string" && name.length > 3 && price && price > 0.5 && price < 2000) {
    const it = clean(store, { name, brand: pick(node, BRAND_KEYS), price, wasPrice: num(pick(node, WAS_KEYS)), url: pick(node, URL_KEYS), image: pick(node, IMG_KEYS), inStock: node.inStock !== false && node.available !== false });
    if (it) { items.push(it); return; }
  }
  for (const k in node) walkData(node[k], items, store, depth + 1);
}

function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "string") { const m = v.replace(/,/g, "").match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; }
  if (typeof v === "object") return num(v.value ?? v.amount ?? v.price ?? v.now ?? v.current ?? v.sale ?? v.min ?? null);
  return null;
}
function str(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return str(v.name || v.title || v.url || v.src || v.href || (Array.isArray(v) ? v[0] : ""));
  return String(v);
}
function absolute(base, u) {
  u = str(u).trim(); if (!u) return null;
  if (u.startsWith("//")) return "https:" + u;
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u.startsWith("/") ? u : "/" + u, base).href; } catch { return null; }
}
function clean(store, it) {
  const name = str(it.name).replace(/\s+/g, " ").trim();
  if (!name || !it.price) return null;
  const was = it.wasPrice && it.wasPrice > it.price ? it.wasPrice : null;
  return {
    store: store.name, name, brand: str(it.brand).trim(), price: Math.round(it.price * 100) / 100,
    wasPrice: was ? Math.round(was * 100) / 100 : null, url: absolute(store.base, it.url), image: absolute(store.base, it.image), inStock: it.inStock !== false,
  };
}
function dedupe(items) {
  const seen = new Set();
  return items.filter(i => { const k = (i.brand + " " + i.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ---------- Matching ---------- */
const STOP = new Set(["the", "and", "with", "for", "of", "a", "ml", "g", "spf", "&", "+", "-"]);
function words(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w)); }
function score(query, item) {
  const q = words(query), hay = new Set(words(item.brand + " " + item.name));
  if (!q.length) return 0;
  return q.filter(w => hay.has(w)).length / q.length;
}

/* ---------- Search (for adding products) ---------- */
const TYPE_WORDS = [
  ["Sunscreen", /sun|spf|uv/], ["Vitamin C serum", /vitamin c|vit c/], ["Serum", /serum|ampoule/], ["Essence", /essence/],
  ["Toner", /toner|tonic|mist/], ["Cleanser", /cleans|wash|foam|balm cleanser|cleansing/], ["Moisturiser", /moistur|cream|lotion|gel cream/],
  ["Eye cream", /eye cream|eye gel/], ["Mask", /mask/], ["Treatment", /retin|acid|bha|aha|exfoli|treatment|spot/],
  ["Mascara", /mascara/], ["Eyeliner", /eyeliner|liner/], ["Foundation", /foundation|skin tint|bb cream|cc cream/], ["Concealer", /conceal/],
  ["Powder", /powder/], ["Blush", /blush/], ["Bronzer", /bronz/], ["Eyeshadow", /eyeshadow|palette/], ["Brows", /brow/],
  ["Lip", /lip|gloss/], ["Primer", /primer/], ["Setting spray", /setting spray|fixing/],
];
function guessType(name) { const n = name.toLowerCase(); for (const [t, re] of TYPE_WORDS) if (re.test(n)) return t; return "Other"; }

async function obfSearch(q) {
  try {
    const r = await get("https://world.openbeautyfacts.org/cgi/search.pl?search_terms=" + encodeURIComponent(q) + "&search_simple=1&action=process&json=1&page_size=20&fields=product_name,brands,image_front_url,image_url", "application/json");
    if (r.status !== 200) return [];
    const d = JSON.parse(r.text);
    return (d.products || []).map(p => ({ store: "Open Beauty Facts", name: str(p.product_name).trim(), brand: str(p.brands).split(",")[0].trim(), image: p.image_front_url || p.image_url || null }))
      .filter(x => x.name && x.image);
  } catch { return []; }
}

async function search(q) {
  const stores = STORES.filter(s => SEARCH_STORES.includes(s.id));
  const [results, obf] = await Promise.all([Promise.all(stores.map(s => checkStore(s, q, false))), obfSearch(q)]);
  const all = [];
  for (const r of results) for (const it of r.items) all.push({ ...it, score: score(q, it) });
  for (const it of obf) all.push({ ...it, score: score(q, it) - 0.01 });
  all.sort((a, b) => b.score - a.score || (b.image ? 1 : 0) - (a.image ? 1 : 0));
  const seen = new Set(), out = [];
  for (const it of all) {
    if (it.score < 0.34) continue;
    const brand = it.brand || "";
    let name = it.name;
    if (brand && name.toLowerCase().startsWith(brand.toLowerCase())) name = name.slice(brand.length).replace(/^[\s\-–:]+/, "");
    const key = (brand + " " + name).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (seen.has(key)) continue; seen.add(key);
    out.push({ name, brand, type: guessType(it.name), image: it.image, store: it.store });
    if (out.length >= 10) break;
  }
  return { q, results: out, stores: results.map(r => ({ store: r.store, status: r.status, found: r.items.length })).concat([{ store: "Open Beauty Facts", status: obf.length ? "ok" : "none", found: obf.length }]) };
}

/* ---------- Prices ---------- */
async function prices(q) {
  const results = await Promise.all(STORES.map(s => checkStore(s, q, false)));
  const out = results.map(r => {
    let best = null, bestScore = 0;
    for (const it of r.items) { const sc = score(q, it); if (sc > bestScore) { bestScore = sc; best = it; } }
    if (best && bestScore >= 0.6) return { store: r.store, status: "ok", price: best.price, wasPrice: best.wasPrice, url: best.url, match: best.name, inStock: best.inStock };
    return { store: r.store, status: r.status === "ok" ? "none" : r.status };
  });
  out.sort((a, b) => (a.price == null) - (b.price == null) || (a.price || 0) - (b.price || 0));
  return { q, checkedAt: new Date().toISOString(), results: out };
}

/* ---------- Photos ---------- */
async function image(src, cors) {
  let u; try { u = new URL(src); } catch { return json({ error: "Bad image address" }, cors, 400); }
  if (u.protocol !== "https:") return json({ error: "Bad image address" }, cors, 400);
  const r = await fetch(u.href, { headers: { "User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" } });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.startsWith("image/")) return json({ error: "Not an image" }, cors, 400);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > 6000000) return json({ error: "Image too large" }, cors, 400);
  return new Response(r.body, { headers: { ...cors, "content-type": type, "cache-control": "public, max-age=86400" } });
}

/* ---------- Test page ---------- */
const TEST_PAGE = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Shelf helper test</title>
<style>
body{font-family:system-ui,sans-serif;background:#FFF4F7;color:#4A2533;margin:0;padding:16px;max-width:720px;margin:auto}
h1{font-size:22px;color:#C2537A}input{font:inherit;padding:10px 12px;border:1px solid #F5D0DC;border-radius:12px;width:100%;box-sizing:border-box}
button{font:inherit;font-weight:700;background:#C2537A;color:#fff;border:none;border-radius:999px;padding:10px 18px;margin-top:8px}
.store{background:#fff;border:1px solid #F5D0DC;border-radius:16px;padding:12px;margin-top:10px}
.ok{color:#2E7D4F}.blocked,.error{color:#B23A4E}.none{color:#8E5D6E}
.item{display:flex;gap:10px;align-items:center;margin-top:8px;font-size:14px}.item img{width:44px;height:44px;object-fit:contain;background:#FFE6EE;border-radius:8px}
small{color:#8E5D6E}pre{white-space:pre-wrap;font-size:12px;color:#8E5D6E;margin:6px 0 0}
</style></head><body>
<h1>My Shelf helper test</h1>
<p>Type a product and tap Test. Each store shows whether it worked. Send Claude a screenshot of the results.</p>
<form id="f"><input id="q" value="Beauty of Joseon Relief Sun" aria-label="Product"><button>Test</button></form>
<div id="out"></div>
<script>
document.getElementById("f").onsubmit=async e=>{e.preventDefault();const q=document.getElementById("q").value.trim();const out=document.getElementById("out");out.textContent="Checking all stores, this takes up to 20 seconds…";
try{const r=await fetch("/api/test?q="+encodeURIComponent(q));const d=await r.json();out.innerHTML="";
for(const s of d.results){const div=document.createElement("div");div.className="store";
const label={ok:"Working",blocked:"Blocked by the store",none:"Opened, but no products read",error:"Error"}[s.status];
div.innerHTML="<b>"+s.store+"</b> <span class='"+s.status+"'>"+label+" ("+s.items.length+" found)</span>";
s.items.slice(0,3).forEach(it=>{const row=document.createElement("div");row.className="item";
if(it.image){const img=document.createElement("img");img.src="/api/image?url="+encodeURIComponent(it.image);img.alt="";row.appendChild(img)}
const box=document.createElement("div");const t=document.createElement("div");t.textContent=(it.brand?it.brand+" · ":"")+it.name;
const sm=document.createElement("small");sm.textContent="$"+Number(it.price).toFixed(2)+(it.wasPrice?" (was $"+Number(it.wasPrice).toFixed(2)+")":"");
box.appendChild(t);box.appendChild(sm);row.appendChild(box);div.appendChild(row)});
const pre=document.createElement("pre");pre.textContent=s.tried.map(t=>t.how+": "+(t.status||"")+(t.blocked?" blocked":"")+(t.message?" "+t.message:"")).join("\\n");div.appendChild(pre);out.appendChild(div)}}
catch(err){out.textContent="The test didn't finish: "+err.message}};
</script></body></html>`;
