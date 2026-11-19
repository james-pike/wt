/**
 * Fill Wills product photos + colour names from the sm SKU manager's image bank.
 *
 * For every colour a Wills product offers (the DB `colors`), look for that
 * product-code + colour's photo in ~/sm/public/skus. Found → copy it to
 * public/skus/ and use it. Not found → leave the image blank (the swatch is
 * still offered). Colour names come from sm's colour labels.
 *
 * Writes src/data/sm-images.json, which fetch-products.ts applies on top of the
 * DB rows (the DB is shared with the old Wills site, so it is left untouched).
 *
 *   npx tsx scripts/sync-sm-images.mts
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { colorName } from "../src/routes/apparel/products";

config({ quiet: true } as any);
const SM = `${homedir()}/sm`;
const BANK = `${SM}/public/skus`;
const OUT_DIR = "public/skus";

const skusSrc = readFileSync(`${SM}/src/data/skus.generated.ts`, "utf8")
  .replace(/^[\s\S]*?export const SKUS: Sku\[\] = /, "").replace(/;\s*$/, "");
const SKUS: { code: string; colors: { slug: string; label: string; swatch: string; image?: string }[] }[] = eval(skusSrc);
const META: Record<string, { label: string; swatch: string }> = JSON.parse(readFileSync(`${SM}/src/data/color-meta.json`, "utf8"));
const smByCode = new Map(SKUS.map((s) => [s.code.toLowerCase(), s]));
// Garment brand per Wills SKU (sm's brand records).
const brandSrc = readFileSync(`${SM}/src/data/brand-skus.generated.ts`, "utf8");
const willsBlock = brandSrc.slice(brandSrc.indexOf('"wills": ['));
const garmentBrand = new Map<string, string>();
for (const m of willsBlock.slice(0, willsBlock.indexOf("\n  ],")).matchAll(/"sku": "([^"]+)"[\s\S]*?"garmentBrand": "([^"]*)"/g)) garmentBrand.set(m[1], m[2]);
const bankFiles = readdirSync(BANK);
const bankByStem = new Map(bankFiles.map((f) => [f.replace(/\.(png|jpe?g|webp)$/i, "").toLowerCase(), f]));

const db = createClient({
  url: process.env.TURSO_URL || process.env.VITE_TURSO_URL || "",
  authToken: process.env.TURSO_AUTH_TOKEN || process.env.VITE_TURSO_AUTH_TOKEN || undefined,
});
const rows = (await db.execute("SELECT sku, code, colors, imgs FROM products WHERE vendor = 'wills' ORDER BY sort_order")).rows as any[];

const norm = (h: string) => (h || "").toLowerCase();
// Product shots that show ONE of several colours: the colour slot they fill.
const BRAND_PHOTO_SLOT: Record<string, string> = { "WT-58": "#5a2733" }; // K288 — maroon
const out: Record<string, { imgs: string[]; names: Record<string, string>; productPhoto?: string; brand?: string }> = {};
let total = 0, found = 0;
const missing: string[] = [];
mkdirSync(OUT_DIR, { recursive: true });

for (const r of rows) {
  const code = String(r.code || "");
  const colors: string[] = JSON.parse(r.colors || "[]");
  const dbImgs: string[] = JSON.parse(r.imgs || "[]");
  const aligned = dbImgs.length === colors.length;
  const sm = smByCode.get(code.toLowerCase());
  const imgs: string[] = [];
  const names: Record<string, string> = {};
  colors.forEach((hex, i) => {
    total++;
    // Candidate colour slugs, best first.
    const cands: string[] = [];
    if (aligned) {
      const stem = dbImgs[i].split("/").pop()!.replace(/\.[a-z]+$/i, "");
      if (stem.toLowerCase().startsWith(code.toLowerCase() + "-")) cands.push(stem.slice(code.length + 1).toLowerCase());
    }
    for (const c of sm?.colors || []) if (norm(c.swatch) === norm(hex)) cands.push(c.slug);
    for (const [slug, m] of Object.entries(META)) if (norm(m.swatch) === norm(hex)) cands.push(slug);
    // Last resort: the colour's name ("#1a1a18" → "Black" → "black").
    const named = colorName(hex, "en");
    if (named && named !== hex) cands.push(named.toLowerCase().replace(/[^a-z0-9]/g, ""));
    let file: string | undefined, slugUsed: string | undefined;
    for (const slug of cands) {
      const f = bankByStem.get(`${code}-${slug}`.toLowerCase());
      if (f) { file = f; slugUsed = slug; break; }
    }
    const label = (slugUsed && (sm?.colors.find((c) => c.slug === slugUsed)?.label || META[slugUsed]?.label))
      || (cands[0] && (sm?.colors.find((c) => c.slug === cands[0])?.label || META[cands[0]]?.label));
    if (label) names[hex] = label;
    if (file) {
      if (!existsSync(`${OUT_DIR}/${file}`)) copyFileSync(`${BANK}/${file}`, `${OUT_DIR}/${file}`);
      imgs.push(`/skus/${file}`);
      found++;
    } else {
      imgs.push("");
      missing.push(`${r.sku} ${code} ${hex}${cands[0] ? ` (${cands[0]})` : ""}`);
    }
  });
  // No colours on the product: use whatever sm has for the code (if anything).
  if (!colors.length) {
    for (const f of bankFiles.filter((f) => f.toLowerCase().startsWith(code.toLowerCase() + "-")).sort()) {
      if (!existsSync(`${OUT_DIR}/${f}`)) copyFileSync(`${BANK}/${f}`, `${OUT_DIR}/${f}`);
      imgs.push(`/skus/${f}`);
    }
    if (!imgs.length) missing.push(`${r.sku} ${code} (no colours, no sm photo)`);
  }
  // sm's product shot for the SKU (sm/public/skus/_brand/WT-N.*), baked with the
  // Wills logo into public/skus/WT-N.png by ~/sm/scripts/bake-wills.py. Used when
  // sm has no colour photo for the product at all (one photo for the product), or
  // to fill the one colour slot the shot shows (BRAND_PHOTO_SLOT).
  const brandPhoto = existsSync(`${OUT_DIR}/${r.sku}.png`) ? `/skus/${r.sku}.png` : undefined;
  let productPhoto: string | undefined;
  if (brandPhoto) {
    const slotHex = BRAND_PHOTO_SLOT[r.sku];
    const slot = slotHex ? colors.findIndex((h) => norm(h) === slotHex) : -1;
    if (slot >= 0 && !imgs[slot]) imgs[slot] = brandPhoto;
    else if (!imgs.some(Boolean)) productPhoto = brandPhoto;
  }
  out[r.sku] = {
    imgs, names,
    ...(productPhoto ? { productPhoto } : {}),
    ...(garmentBrand.get(r.sku) ? { brand: garmentBrand.get(r.sku) } : {}),
  };
}

writeFileSync("src/data/sm-images.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${found}/${total} colours have an sm photo; ${total - found} left blank.`);
if (missing.length) console.log("No sm photo:\n  " + missing.join("\n  "));
