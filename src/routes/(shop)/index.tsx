import { component$ } from "@builder.io/qwik";
import type { DocumentHead } from "@builder.io/qwik-city";

// The catalog IS the home route. The ProductCatalog shell is rendered by the
// group layout; this entry just provides the route + document head. The catalog
// grid shows because the layout's <Slot/> (this component) is empty.
export default component$(() => {
  return <></>;
});

export const head: DocumentHead = {
  title: "Wills Apparel",
  meta: [
    { name: "description", content: "Premium Branded Wills Apparel" },
    { name: "robots", content: "noindex, nofollow" },
    { name: "theme-color", content: "#ffffff" },
    { property: "og:title", content: "Wills Apparel" },
    { property: "og:description", content: "Premium Branded Wills Apparel" },
    { property: "og:type", content: "website" },
    { property: "og:url", content: "https://willsapparel.ca/" },
    { property: "og:image", content: "https://willsapparel.ca/wills-logo.png" },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: "Wills Apparel" },
    { name: "twitter:description", content: "Premium Branded Wills Apparel" },
    { name: "twitter:image", content: "https://willsapparel.ca/wills-logo.png" },
  ],
};
