import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";

config();

const url = process.env.TURSO_URL || process.env.VITE_TURSO_URL || "";

async function fetchAndWrite() {
  // No DB URL (e.g. a preview build without Turso env vars) — keep the committed
  // products.ts rather than crashing the build on an empty URL.
  if (!url) {
    console.log("No TURSO_URL set — skipping product refresh, keeping committed products.ts");
    return;
  }
  const db = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || process.env.VITE_TURSO_AUTH_TOKEN || undefined,
  });
  // Display overrides applied on top of the DB rows. The DB is the source of
  // truth for most fields, but these title/category tweaks live here so they
  // survive every regeneration — editing products.ts directly does NOT persist
  // (this script overwrites it on every build). Update the DB to retire one.
  const OVERRIDES: Record<string, Partial<{ name: string; category: string; sizes: string; img: string; details: string; price: number }>> = {
    // Team Tech half-/quarter-zip pullovers are sweaters, not T-shirts. (Set
    // here, not in the DB — the DB is shared with the old Wills site.)
    "WT-2": { category: "Sweaters" },
    "WT-6": { category: "Sweaters" },
  };

  try {
    const result = await db.execute(
      "SELECT * FROM products WHERE vendor = 'wills' ORDER BY sort_order ASC"
    );

    const products = result.rows
      // Products flagged hidden in the admin are delisted from the storefront —
      // never emitted into the catalog bundle.
      .filter((row: any) => !row.hidden)
      .map((row: any) => ({
        sku: row.sku,
        name: row.name,
        category: row.category,
        sizes: row.sizes,
        badge: row.badge,
        colors: JSON.parse(row.colors || "[]"),
        price: row.price,
        img: row.img,
        imgs: JSON.parse(row.imgs || "[]"),
        material: row.material,
        details: row.details,
        pdf: row.pdf || undefined,
        // Login-group membership (e.g. ["electrical"]); drives the group views.
        portals: row.portals ? JSON.parse(row.portals) : undefined,
      })).map((p) => ({ ...p, ...OVERRIDES[p.sku] }));

    // `defaultHex` picks which colour is the card/gallery default (base.img);
    // without it the first colour (usually black) is used.
    const FOLDS: { keep: string; name?: string; merge?: string[]; defaultHex?: string; colors: { hex: string; img: string }[] }[] = [];
    const bySku = new Map(products.map((p) => [p.sku, p]));
    const dropped = new Set<string>();
    for (const f of FOLDS) {
      const base = bySku.get(f.keep);
      if (!base) continue;
      if (f.name) base.name = f.name;
      base.colors = f.colors.map((c) => c.hex);
      base.imgs = f.colors.map((c) => c.img);
      base.img = (f.defaultHex && f.colors.find((c) => c.hex === f.defaultHex)?.img) || f.colors[0].img;
      for (const s of f.merge ?? []) if (s !== f.keep) dropped.add(s);
    }
    let foldedProducts = products.filter((p) => !dropped.has(p.sku));

    // Strip a trailing " - <Colour>" from every product name; if the product has
    // no colour swatches yet, show that colour as a single swatch instead of the
    // text suffix (so e.g. "… - Black" becomes "…" with a black swatch).
    const COLOUR_HEX: Record<string, string> = {
      black: "#1a1a18", grey: "#6e6e6e", gray: "#6e6e6e", white: "#ffffff",
      green: "#00703c", navy: "#2c3e50", silver: "#94a3b8", charcoal: "#4a4a4a",
    };
    foldedProducts = foldedProducts.map((p) => {
      const m = p.name.match(/[-–]\s*([A-Za-z][A-Za-z ]*?)\s*$/);
      const hex = m && COLOUR_HEX[m[1].trim().toLowerCase()];
      if (!hex) return p;
      const name = p.name.replace(/\s*[-–]\s*[A-Za-z][A-Za-z ]*?\s*$/, "").trim();
      const colors = p.colors && p.colors.length ? p.colors : [hex];
      const imgs = p.imgs && p.imgs.length ? p.imgs : [p.img];
      return { ...p, name, colors, imgs };
    });

    // Wills: photos + colour names from the sm SKU manager's image bank (see
    // scripts/sync-sm-images.mts). One photo per offered colour; a colour sm has
    // no photo for keeps its swatch and shows the blank /skus/no-photo.png.
    const NO_PHOTO = "/skus/no-photo.png";
    const smImages: Record<string, { imgs: string[]; names: Record<string, string>; productPhoto?: string; brand?: string }> =
      existsSync("src/data/sm-images.json") ? JSON.parse(readFileSync("src/data/sm-images.json", "utf8")) : {};
    const smNames: Record<string, string> = {};
    foldedProducts = foldedProducts.map((p) => {
      const sm = smImages[p.sku];
      if (!sm) return p;
      const withBrand = sm.brand ? { ...p, garmentBrand: sm.brand } : p;
      // sm has no colour photos for this product, only its product shot (one
      // photo for every colour) — see sync-sm-images.mts.
      if (sm.productPhoto) return { ...withBrand, imgs: [sm.productPhoto], img: sm.productPhoto };
      if (!p.colors.length) {
        // No colour swatches: sm's photos for the code, else the blank tile.
        const imgs = sm.imgs.filter(Boolean);
        return { ...withBrand, imgs: imgs.length ? imgs : [NO_PHOTO], img: imgs[0] || NO_PHOTO };
      }
      if (sm.imgs.length !== p.colors.length) return withBrand;
      for (const [hex, label] of Object.entries(sm.names)) if (!smNames[hex]) smNames[hex] = label;
      const imgs = sm.imgs.map((i) => i || NO_PHOTO);
      return { ...withBrand, imgs, img: sm.imgs.find(Boolean) || NO_PHOTO };
    });
    const smColourLines = Object.entries(smNames)
      .map(([hex, label]) => `  ${JSON.stringify(hex)}: { en: ${JSON.stringify(label)}, fr: ${JSON.stringify(label)} },`)
      .join("\n");

    const output = `// AUTO-GENERATED — do not edit manually. Updated from database at build time.
import { t } from "../../i18n";
import type { Locale } from "../../i18n";

export const allProducts = ${JSON.stringify(foldedProducts, null, 2)};

export type Product = typeof allProducts[0];

export const categories = ["All", ...Array.from(new Set(allProducts.map((p) => p.category)))];

export const badgeMap: Record<string, string> = { New: "badge.new", Popular: "badge.popular" };
export function badgeClass(badge: string) {
  return badge === "New" ? "product-card__badge product-card__badge--new" : "product-card__badge product-card__badge--popular";
}

// Colour names from the sm SKU manager (Wills' palette); the list below wins
// where both name a colour.
const smColorNames: Record<string, Record<string, string>> = {
${smColourLines}
};
const colorNames: Record<string, Record<string, string>> = {
  ...smColorNames,
  "#00703c": { en: "Green", fr: "Vert" },
  "#1a1a18": { en: "Black", fr: "Noir" },
  "#ffffff": { en: "White", fr: "Blanc" },
  "#2c3e50": { en: "Navy", fr: "Marine" },
  "#6e6e6e": { en: "Grey", fr: "Gris" },
  "#a1a8b0": { en: "Grey", fr: "Gris" }, // towel grey (matches the SM blank swatch)
  "#ff6600": { en: "Safety Orange", fr: "Orange sécurité" },
  "#94a3b8": { en: "Silver", fr: "Argent" },
  "#4a4a4a": { en: "Charcoal", fr: "Charbon" },
  "#6b8bb0": { en: "Solace Blue", fr: "Bleu Solace" },
  "#517fa4": { en: "Copen Blue", fr: "Bleu Copen" },
  "#c9c7c8": { en: "Heather Microchip", fr: "Microchip chiné" },
  "#47536b": { en: "Indigo", fr: "Indigo" },
  "#ca7988": { en: "Red", fr: "Rouge" },
  "#758073": { en: "Balsam Green", fr: "Vert Balsam" },
  "#2a3a49": { en: "Total Eclipse", fr: "Éclipse totale" },
  "#baa591": { en: "Roasted Cashew", fr: "Cajou torréfié" },
  "#9caf88": { en: "Green Bay", fr: "Green Bay" },
  "#3b4657": { en: "Heather Navy", fr: "Marine chiné" },
  "#7dd3fc": { en: "Light Blue", fr: "Bleu clair" },
  "#b8b8b8": { en: "Grey Heather", fr: "Gris chiné" },
  "#6b3fa0": { en: "Purple", fr: "Violet" },
  "#c0392b": { en: "Red", fr: "Rouge" },
  "#1e40af": { en: "Blue", fr: "Bleu" }, // UA polos royal -> shown as Blue (image files still "royal")
  "#8a5d3b": { en: "Carhartt Brown", fr: "Brun Carhartt" },
  "#00b5e2": { en: "Sky Blue", fr: "Bleu ciel" },
  "#0047ab": { en: "Cobalt", fr: "Cobalt" },
  "#0f52ba": { en: "Sapphire", fr: "Saphir" },
  "#1b2a41": { en: "Navy", fr: "Marine" },
  "#1e4d2b": { en: "Forest Green", fr: "Vert forêt" },
  "#1f6f6f": { en: "Teal", fr: "Sarcelle" },
  "#2b2b2b": { en: "Charcoal", fr: "Charbon" },
  "#2c5aa0": { en: "Royal Blue", fr: "Bleu royal" },
  "#333333": { en: "Charcoal", fr: "Charbon" },
  "#33425b": { en: "Slate Blue", fr: "Bleu ardoise" },
  "#383838": { en: "Charcoal", fr: "Charbon" },
  "#3a3a3a": { en: "Charcoal", fr: "Charbon" },
  "#3a5bbf": { en: "Royal Blue", fr: "Bleu royal" },
  "#3a8fb7": { en: "Blue", fr: "Bleu" },
  "#3758a9": { en: "Blue", fr: "Bleu" },
  "#3d4a63": { en: "Slate Blue", fr: "Bleu ardoise" },
  "#3f3f3f": { en: "Charcoal", fr: "Charbon" },
  "#4a2545": { en: "Plum", fr: "Prune" },
  "#4b5320": { en: "Olive", fr: "Olive" },
  "#4f6b45": { en: "Sage Green", fr: "Vert sauge" },
  "#585858": { en: "Grey", fr: "Gris" },
  "#5a2733": { en: "Maroon", fr: "Bordeaux" },
  "#5a5a5a": { en: "Grey", fr: "Gris" },
  "#5a6248": { en: "Olive", fr: "Olive" },
  "#5b6d7e": { en: "Slate", fr: "Ardoise" },
  "#5b7fa6": { en: "Steel Blue", fr: "Bleu acier" },
  "#5c1a2b": { en: "Maroon", fr: "Bordeaux" },
  "#5e2233": { en: "Maroon", fr: "Bordeaux" },
  "#6a6d70": { en: "Grey", fr: "Gris" },
  "#6b1f2a": { en: "Maroon", fr: "Bordeaux" },
  "#6b3f2a": { en: "Brown", fr: "Brun" },
  "#6b6a4a": { en: "Olive", fr: "Olive" },
  "#6b6f74": { en: "Grey", fr: "Gris" },
  "#6d2b3f": { en: "Maroon", fr: "Bordeaux" },
  "#6e7377": { en: "Grey", fr: "Gris" },
  "#6e8ca0": { en: "Steel Blue", fr: "Bleu acier" },
  "#7a3540": { en: "Maroon", fr: "Bordeaux" },
  "#7a7a7a": { en: "Grey", fr: "Gris" },
  "#7a8fa6": { en: "Steel Blue", fr: "Bleu acier" },
  "#7ba4d0": { en: "Light Blue", fr: "Bleu clair" },
  "#7c7a5e": { en: "Olive", fr: "Olive" },
  "#8a8a8a": { en: "Grey", fr: "Gris" },
  "#8c1d2c": { en: "Cardinal", fr: "Cardinal" },
  "#9b9b9b": { en: "Grey", fr: "Gris" },
  "#a0a0a0": { en: "Grey", fr: "Gris" },
  "#a6a6a6": { en: "Grey", fr: "Gris" },
  "#a8c4d8": { en: "Light Blue", fr: "Bleu clair" },
  "#a9682f": { en: "Brown", fr: "Brun" },
  "#b0b0b0": { en: "Grey", fr: "Gris" },
  "#b6e021": { en: "Safety Green", fr: "Vert sécurité" },
  "#b8ad97": { en: "Khaki", fr: "Kaki" },
  "#ab8f66": { en: "Dark Khaki", fr: "Kaki foncé" },
  "#b98b8b": { en: "Rose", fr: "Rose" },
  "#bf5700": { en: "Burnt Orange", fr: "Orange brûlé" },
  "#c2a878": { en: "Tan", fr: "Beige" },
  "#c2c2c2": { en: "Light Grey", fr: "Gris clair" },
  "#c3a984": { en: "Tan", fr: "Beige" },
  "#c65b52": { en: "Coral", fr: "Corail" },
  "#c9b79c": { en: "Tan", fr: "Beige" },
  "#c9ccc9": { en: "Light Grey", fr: "Gris clair" },
  "#e3c9c9": { en: "Pink", fr: "Rose" },
  "#e8863b": { en: "Orange", fr: "Orange" },
  "#f2efe6": { en: "Natural", fr: "Naturel" },
  "#ff6a13": { en: "Orange", fr: "Orange" },

};
export function colorName(hex: string, locale: Locale): string {
  return colorNames[hex]?.[locale] || hex;
}

export function categoryLabel(cat: string, locale: Locale): string {
  if (cat === "All") return t("apparel.all", locale);
  const key = \`cat.\${cat}\` as any;
  return t(key, locale);
}

export function expandSizes(sizes: string): string[] {
  if (sizes === "One Size") return ["One Size"];
  const order = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL"];
  const match = sizes.match(/^(\\w+)\\s*-\\s*(\\w+)$/);
  if (!match) return [sizes];
  const start = order.indexOf(match[1]);
  const end = order.indexOf(match[2]);
  if (start === -1 || end === -1) return [sizes];
  return order.slice(start, end + 1);
}
`;

    writeFileSync("src/routes/apparel/products.ts", output);
    console.log(`Wrote ${products.length} products from database`);
  } catch (e: any) {
    console.error("Failed to fetch from database, keeping existing products.ts:", e.message);
    // Don't fail the build — keep the existing hardcoded file
  }
}

fetchAndWrite();
