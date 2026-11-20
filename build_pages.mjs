// Builds search-engine-visible static pages (products, manufacturers, categories) plus sitemap.xml and robots.txt.
// Runs nightly in GitHub Actions after sync_data.py. Reads category definitions straight from index.html so the two never drift.
import fs from "node:fs";
import path from "node:path";

const SITE = "https://creambiomedscientific.com";
const WA = "256782711220";
const API = "https://api.fda.gov/device/udi.json";
const PER_SUB = Number(process.env.PER_SUB || 300);
const html = fs.readFileSync("index.html", "utf8");

// ---- pull shared definitions from index.html
const grab = (re) => { const m = html.match(re); if (!m) throw new Error("index.html missing " + re); return m[0]; };
const defs = [
  grab(/const ACTIVE=[^\n]+/), grab(/const EXQ=[^\n]+/), grab(/const RNC=[^\n]+/), grab(/const G=[^\n]+/),
  grab(/const DEPTS=\[[\s\S]*?\n\];/), grab(/const LEGAL=[^\n]+/), grab(/function normName[^\n]+/), grab(/const MAKER_SITES=[^\n]+/),
].join("\n");
const { ACTIVE, EXQ, DEPTS, normName, MAKER_SITES } = new Function(defs + "\nreturn {ACTIVE,EXQ,DEPTS,normName,MAKER_SITES};")();

// ---- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slug = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
const titleCase = (s) => String(s || "").toLowerCase().replace(/(^|[\s\-\(\/])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Inc|Llc|Ltd|Co|Ag|Sa|Bv|Plc|Usa|Uk|Ge|Gmbh)\b/g, (m) => (m === "Gmbh" ? "GmbH" : m.toUpperCase()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const devClass = (d) => { const c = d.product_codes?.[0]?.openfda?.device_class; return c && /^[123]$/.test(c) ? c : null; };
const primaryDI = (d) => (d.identifiers || []).find((i) => i.type === "Primary")?.id || d.identifiers?.[0]?.id || "";
const REGION = new Set(["shenzhen","beijing","guangdong","jiangsu","shanghai","zhejiang","guangzhou","hangzhou","suzhou","nanjing","wuhan","tianjin","xuzhou","changzhou","ningbo","hefei","qingdao","xiamen","foshan"]);
const makerWord = (name) => normName(name).split(" ").filter((t) => !REGION.has(t))[0] || normName(name).split(" ")[0] || "";
const domFor = (name) => { const k = normName(name).split(" "); const f = ["shenzhen", "beijing", "guangdong", "jiangsu", "shanghai", "zhejiang"].includes(k[0]) ? k[1] : k[0]; return MAKER_SITES[f] || ""; };

async function fda(params, tries = 5) {
  const url = API + "?" + Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { results: [] };
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(3000); }
  }
  return { results: [] };
}

// ---- catalogue (manufacturer website data collected by sync_data.py)
const catCache = {};
function catalog(dom) {
  if (!dom) return [];
  if (!(dom in catCache)) { try { catCache[dom] = JSON.parse(fs.readFileSync(`data/catalog/${dom}.json`, "utf8")).items || []; } catch { catCache[dom] = []; } }
  return catCache[dom];
}
const CSTOP = new Set("system systems monitor monitors patient series medical device devices unit units the and with for ultrasound diagnostic portable digital mobile model new pro plus".split(" "));
function matchCatalog(items, d) {
  const toks = [...new Set([d.brand_name, d.version_or_model_number].join(" ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !CSTOP.has(t) && !/^\d+$/.test(t)))];
  if (!toks.length) return null;
  let best = null, bs = 0;
  for (const it of items) {
    let p = it[0]; try { p = decodeURIComponent(new URL(it[0]).pathname); } catch {}
    const txt = (p + " " + it[1]).toLowerCase().replace(/[^a-z0-9]+/g, "");
    let s = 0;
    for (const t of toks) { if (txt.includes(t)) s += 3; else { const q = t.replace(/\d+[a-z]?$/, ""); if (q.length >= 4 && q !== t && txt.includes(q)) s += 1; } }
    if (s > bs) { bs = s; best = it; }
  }
  return bs >= 3 ? best : null;
}

// ---- page shell
const LOGO = '<svg width="34" height="34" viewBox="0 0 64 64"><path d="M32 4a28 28 0 0 1 0 56" fill="none" stroke="#d7262e" stroke-width="5"/><path d="M32 60a28 28 0 0 1 0-56" fill="none" stroke="#1f3fbf" stroke-width="5"/><path d="M6 36h12l4-9 6 17 5-24 5 22 4-6h16" fill="none" stroke="#1f3fbf" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><text x="32" y="25" text-anchor="middle" font-family="Inter,Arial" font-weight="800" font-size="13" fill="#d7262e">CBS</text></svg>';
const CSS = `*{box-sizing:border-box}body{margin:0;font:15px/1.6 Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#1b2333;background:#f5f7fb}a{color:#1f3fbf;text-decoration:none}a:hover{text-decoration:underline}
.top{background:#0f1a3a;color:#fff}.wrap{max-width:1120px;margin:0 auto;padding:0 20px}.nav{display:flex;align-items:center;gap:18px;min-height:64px;flex-wrap:wrap}.brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:800;letter-spacing:.3px}.brand small{display:block;font-weight:400;font-size:11px;opacity:.75;letter-spacing:0}.logo{background:#fff;border-radius:50%;padding:3px;display:grid}
.nav nav{display:flex;gap:16px;flex-wrap:wrap;margin-left:auto}.nav nav a{color:#dfe6ff;font-size:14px}.crumbs{font-size:13px;color:#5b6577;padding:14px 0}.card{background:#fff;border:1px solid #e3e8f2;border-radius:14px;padding:20px;margin-bottom:16px}
h1{font-size:28px;line-height:1.25;margin:0 0 6px}h2{font-size:19px;margin:0 0 10px}.note{color:#5b6577;font-size:13.5px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #eef1f7;vertical-align:top;font-size:14px}th{width:38%;color:#5b6577;font-weight:600}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;font-weight:700;font-size:14px;margin:4px 6px 4px 0}.btn-r{background:#d7262e;color:#fff}.btn-g{background:#eef2ff;color:#1f3fbf}.btn:hover{text-decoration:none;filter:brightness(.95)}
.tag{display:inline-block;background:#eef2ff;color:#1f3fbf;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;margin-right:6px}.list{columns:2;column-gap:28px;padding-left:18px}@media(max-width:620px){.list{columns:1}}.list li{break-inside:avoid;margin-bottom:4px}
.photo{background:#fff;border:1px solid #e3e8f2;border-radius:12px;padding:10px;text-align:center}.photo img{max-width:100%;max-height:300px;object-fit:contain}foot,footer{display:block;color:#5b6577;font-size:13px;padding:28px 0 40px}`;
function page({ title, desc, canon, crumbs, body, jsonld }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${canon}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}${canon}"><meta property="og:site_name" content="Cream Biomed">
<link rel="stylesheet" href="/static.css">${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
<script defer src="/stats.js"></script></head><body>
<header class="top"><div class="wrap nav"><a class="brand" href="/"><span class="logo">${LOGO}</span><span>CREAM BIOMED<small>and Scientific Limited</small></span></a>
<nav><a href="/#/equipment">Equipment</a><a href="/m/">Manufacturers</a><a href="/c/">Categories</a><a href="/#/manuals">Manuals</a><a href="/#/services">Services</a><a href="/#/list">Register as supplier</a></nav></div></header>
<main class="wrap"><div class="crumbs">${crumbs}</div>${body}</main>
<footer class="wrap">© ${new Date().getUTCFullYear()} Cream Biomed and Scientific Limited · Equipment sourcing, installation, training and maintenance · WhatsApp <a href="https://wa.me/${WA}">+${WA}</a><br>Regulatory data: U.S. FDA GUDID via openFDA. Product photos and descriptions belong to their manufacturers and link to the original pages.</footer></body></html>`;
}
const waLink = (t) => `https://wa.me/${WA}?text=${encodeURIComponent(t)}`;

function write(rel, content) {
  const f = path.join(".", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  try { if (fs.readFileSync(f, "utf8") === content) return; } catch {}
  fs.writeFileSync(f, content);
}

// ---- main
async function main() {
  const products = new Map(); // slug -> {d, subs:Set}
  const makers = new Map(); // slug -> {name, subs: Map(subId->count), products:Set(slug)}
  const subInfo = {};
  for (const dept of DEPTS) for (const [id, name, q, sdesc] of dept.subs) {
    subInfo[id] = { id, name, desc: sdesc, dept, products: [], makers: [] };
    const search = `(${q}) AND ${ACTIVE}${dept.noExq ? "" : EXQ}`;
    let got = 0;
    for (let skip = 0; skip < PER_SUB && skip < 25000; skip += 100) {
      const j = await fda({ search, limit: 100, skip });
      const res = j.results || [];
      for (const d of res) {
        if (!d.public_device_record_key || !d.company_name) continue;
        const name = d.brand_name || d.gmdn_terms?.[0]?.name || "";
        if (!name) continue;
        const s = slug(`${makerWord(d.company_name)} ${name} ${d.version_or_model_number || ""}`);
        if (!products.has(s)) { products.set(s, { d, subs: new Set() }); got++; }
        products.get(s).subs.add(id);
        if (!subInfo[id].products.includes(s)) subInfo[id].products.push(s);
      }
      if (res.length < 100) break;
      await sleep(300);
    }
    const mk = await fda({ search, count: "company_name.exact", limit: 100 });
    for (const m of mk.results || []) {
      const ms = slug(normName(m.term) || m.term);
      if (!makers.has(ms)) makers.set(ms, { name: m.term, subs: new Map(), products: new Set() });
      makers.get(ms).subs.set(id, (makers.get(ms).subs.get(id) || 0) + m.count);
      subInfo[id].makers.push([ms, m.count]);
    }
    console.log(`${id}: ${got} new products, ${(mk.results || []).length} makers`);
    await sleep(300);
  }
  for (const [s, p] of products) {
    const ms = slug(normName(p.d.company_name) || p.d.company_name);
    if (!makers.has(ms)) makers.set(ms, { name: p.d.company_name, subs: new Map(), products: new Set() });
    makers.get(ms).products.add(s);
    p.maker = ms;
  }
  if (products.size < Number(process.env.MIN_PRODUCTS || 200)) throw new Error(`Only ${products.size} products fetched; keeping existing pages.`);

  const urls = ["/", "/c/", "/m/"];
  const subLink = (id) => `<a href="/c/${id}.html">${esc(subInfo[id].name)}</a>`;

  // product pages
  for (const [s, p] of products) {
    const d = p.d, g = d.gmdn_terms?.[0], pc = d.product_codes?.[0], mk = makers.get(p.maker), mname = titleCase(d.company_name);
    const name = d.brand_name || g?.name;
    const model = d.version_or_model_number || "";
    const sub = subInfo[[...p.subs][0]];
    const cat = matchCatalog(catalog(domFor(d.company_name)).filter((x) => x[2] || (x[5] || []).length || (x[6] || []).length), d);
    const full = `${name}${model && !name.toLowerCase().includes(model.toLowerCase()) ? " " + model : ""}`;
    const title = `${full} by ${mname} — ${sub.name} | Cream Biomed`;
    const desc = `${full} (${g?.name || sub.name}) from ${mname}. Specifications, regulatory status, manuals, distributors and quotes. Sourcing, installation and maintenance by Cream Biomed.`.slice(0, 300);
    const rows = [["Manufacturer", `<a href="/m/${p.maker}.html">${esc(mname)}</a>`], ["Brand", esc(d.brand_name)], ["Model / version", esc(model)], ["Catalogue number", esc(d.catalog_number)], ["Device type", esc(g?.name)], ["Category", subLink(sub.id)], ["FDA product code", pc ? `${esc(pc.code)} — ${esc(pc.name)}` : ""], ["FDA risk class", devClass(d) ? `Class ${devClass(d)}` : ""], ["US market status", "In commercial distribution"], ["Use", d.is_rx ? "Prescription / professional use" : d.is_otc ? "Over the counter" : ""], ["MRI safety", esc(d.mri_safety)], ["Device identifier (GUDID)", primaryDI(d) ? `<a href="https://accessgudid.nlm.nih.gov/devices/${encodeURIComponent(primaryDI(d))}" rel="nofollow noopener" target="_blank">${esc(primaryDI(d))}</a>` : ""]].filter((r) => r[1]);
    const related = sub.products.filter((x) => x !== s).slice(0, 14);
    const body = `<div class="grid"><div><div class="card"><span class="tag">${esc(sub.dept.name)}</span><span class="tag">${esc(sub.name)}</span><h1>${esc(full)}</h1><div class="note">by <a href="/m/${p.maker}.html">${esc(mname)}</a></div>
${d.device_description ? `<p>${esc(d.device_description)}</p>` : ""}${g?.definition ? `<p class="note"><b>What this type of device does:</b> ${esc(g.definition)}</p>` : ""}
${cat ? `<div class="photo"><a href="${esc(cat[0])}" rel="noopener" target="_blank"><img src="${esc(cat[2])}" alt="${esc(full)}" loading="lazy" referrerpolicy="no-referrer"></a><div style="text-align:left;margin-top:8px"><b>${esc(cat[1])}</b>${cat[3] ? `<p class="note" style="margin:4px 0">${esc(cat[3])}</p>` : ""}<div class="note">Source: <a href="${esc(cat[0])}" rel="noopener" target="_blank">${esc(new URL(cat[0]).hostname.replace(/^www\./, ""))} ↗</a></div></div></div>` : ""}
<p><a class="btn btn-r" href="${waLink(`Hello Cream Biomed, I would like a quote for: ${full} (${mname}).`)}" rel="nofollow">Request a quote on WhatsApp</a><a class="btn btn-g" href="/#/device/${encodeURIComponent(d.public_device_record_key)}">Full details, photos, manuals &amp; distributors</a></p></div>
${cat && (cat[5] || []).length ? `<div class="card"><h2>Manufacturer specifications</h2><table>${cat[5].map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join("")}</table><p class="note">Source: <a href="${esc(cat[0])}" rel="noopener" target="_blank">${esc(new URL(cat[0]).hostname.replace(/^www\./, ""))}</a></p></div>` : ""}
${cat && (cat[6] || []).length ? `<div class="card"><h2>Manuals &amp; documents</h2><ul style="padding-left:18px;margin:0">${cat[6].map(([l, u]) => `<li><a href="${esc(u)}" rel="noopener nofollow" target="_blank">${esc(l)}</a></li>`).join("")}</ul><p class="note">Official documents from the manufacturer. Service manuals on request.</p></div>` : ""}
<div class="card"><h2>Specifications &amp; regulatory details</h2><table>${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("")}</table><p class="note">Source: U.S. FDA GUDID via openFDA. FDA clearance does not mean the device is registered in your country; Cream Biomed can check local registration for you.</p></div></div>
<div><div class="card"><h2>Cream Biomed services</h2><ul style="padding-left:18px;margin:0"><li>Sourcing and quotations from the manufacturer or authorised distributors</li><li>Delivery, installation and commissioning</li><li>User and technical training</li><li>Preventive maintenance, repair and calibration</li><li>User and service manuals</li></ul><p><a class="btn btn-r" href="${waLink(`Hello Cream Biomed, I need help with: ${full} (${mname}).`)}" rel="nofollow">Talk to an engineer</a></p></div>
<div class="card"><h2>More ${esc(sub.name.toLowerCase())}</h2><ul style="padding-left:18px;margin:0">${related.map((r) => `<li><a href="/p/${r}.html">${esc(products.get(r).d.brand_name || "")} ${esc(products.get(r).d.version_or_model_number || "")}</a> <span class="note">· ${esc(titleCase(products.get(r).d.company_name))}</span></li>`).join("")}</ul><p><a href="/c/${sub.id}.html">All ${esc(sub.name.toLowerCase())} →</a></p></div></div></div>`;
    const jsonld = { "@context": "https://schema.org", "@type": "Product", name: full, brand: { "@type": "Brand", name: d.brand_name || mname }, manufacturer: { "@type": "Organization", name: mname }, model: model || undefined, category: `${sub.dept.name} > ${sub.name}`, description: d.device_description || g?.definition || undefined, gtin: /^\d{8,14}$/.test(primaryDI(d)) ? primaryDI(d) : undefined, image: cat ? cat[2] : undefined, url: `${SITE}/p/${s}.html` };
    write(`p/${s}.html`, page({ title, desc, canon: `/p/${s}.html`, crumbs: `<a href="/">Home</a> / <a href="/c/">Categories</a> / ${subLink(sub.id)} / ${esc(full)}`, body, jsonld }));
    urls.push(`/p/${s}.html`);
  }

  // manufacturer pages
  const makerList = [...makers.entries()].filter(([, m]) => m.products.size || m.subs.size).sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [ms, m] of makerList) {
    const mname = titleCase(m.name), dom = domFor(m.name);
    const subsList = [...m.subs.entries()].sort((a, b) => b[1] - a[1]);
    const prods = [...m.products].slice(0, 300);
    const body = `<div class="card"><h1>${esc(mname)}</h1><p class="note">Medical equipment manufacturer${dom ? ` · <a href="https://${dom}" rel="noopener" target="_blank">${esc(dom)} ↗</a>` : ""}</p>
<p>Browse ${esc(mname)} equipment that is currently on the market, with regulatory details, manuals and distributor information. Cream Biomed sources ${esc(mname)} products and provides installation, training and maintenance.</p>
<p><a class="btn btn-r" href="${waLink(`Hello Cream Biomed, I would like a quote for ${mname} equipment.`)}" rel="nofollow">Request a quote</a><a class="btn btn-g" href="/#/maker/${encodeURIComponent(m.name)}">Full catalogue, countries &amp; distributors</a></p></div>
${subsList.length ? `<div class="card"><h2>Equipment categories</h2><ul class="list">${subsList.map(([id, n]) => `<li>${subLink(id)} <span class="note">· ${n.toLocaleString()} records</span></li>`).join("")}</ul></div>` : ""}
${prods.length ? `<div class="card"><h2>Products</h2><ul class="list">${prods.map((r) => { const d = products.get(r).d; return `<li><a href="/p/${r}.html">${esc(d.brand_name || d.gmdn_terms?.[0]?.name)} ${esc(d.version_or_model_number || "")}</a></li>`; }).join("")}</ul></div>` : ""}`;
    write(`m/${ms}.html`, page({ title: `${mname} medical equipment — products, manuals & distributors | Cream Biomed`, desc: `${mname} medical equipment: ${subsList.slice(0, 5).map(([id]) => subInfo[id].name.toLowerCase()).join(", ")}. Regulatory status, manuals, distributors and quotes from Cream Biomed.`, canon: `/m/${ms}.html`, crumbs: `<a href="/">Home</a> / <a href="/m/">Manufacturers</a> / ${esc(mname)}`, body, jsonld: { "@context": "https://schema.org", "@type": "Organization", name: mname, url: dom ? `https://${dom}` : undefined } }));
    urls.push(`/m/${ms}.html`);
  }
  const letters = {};
  for (const [ms, m] of makerList) { const L = /^[a-z]/i.test(m.name) ? m.name[0].toUpperCase() : "#"; (letters[L] ||= []).push(`<li><a href="/m/${ms}.html">${esc(titleCase(m.name))}</a></li>`); }
  write("m/index.html", page({ title: "Medical equipment manufacturers A–Z | Cream Biomed", desc: `Directory of ${makerList.length.toLocaleString()} medical equipment manufacturers with market-ready products, manuals and distributors.`, canon: "/m/", crumbs: `<a href="/">Home</a> / Manufacturers`, body: `<div class="card"><h1>Medical equipment manufacturers</h1><p class="note">${makerList.length.toLocaleString()} manufacturers with equipment currently on the market.</p>${Object.keys(letters).sort().map((L) => `<h2>${L}</h2><ul class="list">${letters[L].join("")}</ul>`).join("")}</div>` }));

  // category pages
  for (const id in subInfo) {
    const si = subInfo[id];
    const mk = si.makers.sort((a, b) => b[1] - a[1]).slice(0, 40);
    const body = `<div class="card"><span class="tag">${esc(si.dept.name)}</span><h1>${esc(si.name)}</h1><p>${esc(si.desc)}. Compare market-ready ${esc(si.name.toLowerCase())} from manufacturers worldwide, with regulatory details, manuals and quotes.</p>
<p><a class="btn btn-r" href="${waLink(`Hello Cream Biomed, I need ${si.name.toLowerCase()}. Please advise.`)}" rel="nofollow">Get a quote</a><a class="btn btn-g" href="/#/c/${si.dept.id}/${id}">Search &amp; filter all ${esc(si.name.toLowerCase())}</a></p></div>
<div class="card"><h2>Leading manufacturers</h2><ul class="list">${mk.map(([ms, n]) => `<li><a href="/m/${ms}.html">${esc(titleCase(makers.get(ms)?.name || ms))}</a> <span class="note">· ${n.toLocaleString()}</span></li>`).join("")}</ul></div>
<div class="card"><h2>Products</h2><ul class="list">${si.products.map((r) => { const d = products.get(r).d; return `<li><a href="/p/${r}.html">${esc(d.brand_name || "")} ${esc(d.version_or_model_number || "")}</a> <span class="note">· ${esc(titleCase(d.company_name))}</span></li>`; }).join("")}</ul></div>`;
    write(`c/${id}.html`, page({ title: `${si.name} — compare models & manufacturers | Cream Biomed`, desc: `${si.desc}. Compare ${si.products.length} market-ready ${si.name.toLowerCase()} from ${mk.length}+ manufacturers. Quotes, installation and maintenance from Cream Biomed.`, canon: `/c/${id}.html`, crumbs: `<a href="/">Home</a> / <a href="/c/">Categories</a> / ${esc(si.name)}`, body }));
    urls.push(`/c/${id}.html`);
  }
  let who = [];
  try { who = JSON.parse(fs.readFileSync("data/who_ivd.json", "utf8")).rows || []; } catch {}
  if (who.length) {
    const byD = {};
    for (const r of who) (byD[r[6] || "Other"] ||= []).push(r);
    const body = `<div class="card"><span class="tag">Lab Reagents &amp; Consumables</span><h1>WHO-prequalified diagnostics</h1><p>${who.length} in vitro diagnostics assessed by the World Health Organization and found acceptable, in principle, for procurement by UN agencies: malaria, HIV, hepatitis, syphilis, HPV, TB and more. Cream Biomed sources these tests and checks national registration.</p><p><a class="btn btn-r" href="${waLink("Hello Cream Biomed, I need a quote for WHO-prequalified diagnostics.")}" rel="nofollow">Get a quote</a><a class="btn btn-g" href="/#/who">Search &amp; filter the WHO list</a></p></div>` +
      Object.keys(byD).sort().map((d) => `<div class="card"><h2>${esc(d)}</h2><table><tr><th>Product</th><th>Manufacturer</th><th>Assay format</th></tr>${byD[d].map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[5])}</td><td>${esc(r[3])}</td></tr>`).join("")}</table></div>`).join("") +
      `<p class="note">Source: <a href="https://extranet.who.int/prequal/vitro-diagnostics/prequalified/in-vitro-diagnostics" rel="noopener" target="_blank">WHO list of prequalified in vitro diagnostic products</a>. Inclusion does not imply WHO endorsement or national approval.</p>`;
    write("c/who.html", page({ title: "WHO-prequalified diagnostics: malaria, HIV, hepatitis, syphilis tests | Cream Biomed", desc: `${who.length} WHO-prequalified in vitro diagnostics, including malaria and HIV rapid tests, from manufacturers worldwide. Quotes and sourcing by Cream Biomed.`, canon: "/c/who.html", crumbs: `<a href="/">Home</a> / <a href="/c/">Categories</a> / WHO-prequalified diagnostics`, body }));
    urls.push("/c/who.html");
  }
  write("c/index.html", page({ title: "Medical equipment categories | Cream Biomed", desc: "Browse medical equipment by hospital department: monitoring, imaging, respiratory, surgery, emergency, maternal, laboratory, sterilisation, dental, eye & ENT, furniture and dialysis.", canon: "/c/", crumbs: `<a href="/">Home</a> / Categories`, body: (who.length ? `<div class="card"><h2><a href="/c/who.html">WHO-prequalified diagnostics</a></h2><p class="note">${who.length} malaria, HIV, hepatitis, syphilis and other tests assessed by WHO.</p></div>` : "") + DEPTS.map((dp) => `<div class="card"><h2>${esc(dp.name)}</h2><p class="note">${esc(dp.desc)}</p><ul class="list">${dp.subs.map((s) => `<li>${subLink(s[0])} <span class="note">· ${subInfo[s[0]].products.length} products</span></li>`).join("")}</ul></div>`).join("") }));

  // service landing pages
  const SV = [
    ["repair", "Medical equipment repair & servicing", "Book biomedical engineers to diagnose, repair and service patient monitors, ultrasound, ventilators, lab analysers, autoclaves and more, from all major brands. Track your job with a reference number.", "#/repair"],
    ["spare-parts", "Medical equipment spare parts & accessories", "Probes, SpO2 sensors, ECG cables, BP cuffs, batteries, breathing circuits and other parts by device brand and model, original or quality-tested compatible.", "#/parts"],
    ["used-rental", "Used & rental medical equipment", "Buy, sell or hire pre-owned medical and laboratory equipment. Every listing is reviewed, and equipment can be inspected, serviced and installed by our engineers.", "#/market"],
    ["asset-register", "Free medical equipment asset register", "Keep your facility's equipment inventory with service dates, export to Excel and get preventive maintenance reminders in your calendar.", "#/assets"],
    ["calibration", "Medical equipment calibration & electrical safety testing", "Electrical safety testing (IEC 62353), performance verification and calibration certificates for monitors, defibrillators, infusion pumps, ventilators, autoclaves and lab equipment.", "#/calibration"],
    ["training", "Medical equipment installation & training", "Installation and commissioning plus practical training for clinical users and in-house technicians, on site or online.", "#/training"],
    ["import-registration", "Medical device import & registration", "Help with supplier documents, shipping, customs clearance and registration with NDA Uganda, PPB Kenya, TMDA Tanzania and Rwanda FDA.", "#/import"],
    ["financing", "Medical equipment financing & leasing", "Compare instalment plans, leasing, rent-to-own and short-term rental options for hospitals, clinics and laboratories.", "#/finance"],
    ["tenders", "Medical equipment tenders in East Africa", "Current tenders for medical equipment, reagents and services, with help preparing compliant, competitive bids.", "#/tenders"],
  ];
  for (const [sl, t, d, h] of SV) {
    write(`services/${sl}.html`, page({ title: `${t} | Cream Biomed`, desc: d, canon: `/services/${sl}.html`, crumbs: `<a href="/">Home</a> / <a href="/services/">Services</a> / ${esc(t)}`,
      body: `<div class="card"><h1>${esc(t)}</h1><p>${esc(d)}</p><p>Cream Biomed and Scientific Limited is a team of biomedical engineers and medical doctors serving hospitals, clinics and laboratories in Uganda and East Africa.</p><p><a class="btn btn-r" href="/${h}">Get started</a><a class="btn btn-g" href="${waLink(`Hello Cream Biomed, I'd like help with: ${t}.`)}" rel="nofollow">WhatsApp us</a></p></div><div class="card"><h2>Other services</h2><ul class="list">${SV.filter((x) => x[0] !== sl).map((x) => `<li><a href="/services/${x[0]}.html">${esc(x[1])}</a></li>`).join("")}</ul></div>` }));
    urls.push(`/services/${sl}.html`);
  }
  write("services/index.html", page({ title: "One-stop medical equipment services | Cream Biomed", desc: "Sourcing, lab reagents, repair, spare parts, used and rental equipment, calibration, training, import, financing and tenders from Cream Biomed.", canon: "/services/", crumbs: `<a href="/">Home</a> / Services`,
    body: `<div class="card"><h1>One-stop medical equipment services</h1><ul class="list">${SV.map((x) => `<li><a href="/services/${x[0]}.html">${esc(x[1])}</a></li>`).join("")}</ul></div>` }));
  urls.push("/services/");

  // sitemaps (max 50k URLs each)
  const today = new Date().toISOString().slice(0, 10);
  const chunks = []; for (let i = 0; i < urls.length; i += 40000) chunks.push(urls.slice(i, i + 40000));
  chunks.forEach((c, i) => write(`sitemap-${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${c.map((u) => `<url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`));
  write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${chunks.map((c, i) => `<sitemap><loc>${SITE}/sitemap-${i + 1}.xml</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`);
  write("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  write("static.css", CSS);
  console.log(`Built ${products.size} product, ${makerList.length} manufacturer and ${Object.keys(subInfo).length} category pages; ${urls.length} URLs in sitemap.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
