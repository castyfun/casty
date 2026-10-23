import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

// The site is built for the root locally and in CI; the Pages workflow sets these for
// https://savvax.github.io/casty/.
const site = process.env.DOCS_SITE;
const base = process.env.DOCS_BASE ?? "/";

// Pages link to each other with relative links (../guide/): they hold under any base, and a
// translation, under /ru/ and the like, keeps every page at the same depth below its locale.

export default defineConfig({
  site,
  base,
  // The few screenshots are already small PNGs; resizing them would need sharp.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "casty",
      description:
        "Your own Farcaster read node, and a client that reads from it and writes through it.",
      customCss: ["./src/styles/custom.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/savvax/casty" }],
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ru: { label: "Русский", lang: "ru" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
        es: { label: "Español", lang: "es" },
        fr: { label: "Français", lang: "fr" },
        ar: { label: "العربية", lang: "ar", dir: "rtl" },
      },
      sidebar: [
        "index",
        "guide",
        "commands",
        "0-provision",
        "1-node",
        "2-client",
        "web",
        "serve",
        "home-node",
        {
          label: "Concepts",
          translations: {
            ru: "Основы",
            "zh-CN": "概念",
            es: "Conceptos",
            fr: "Concepts",
            ar: "مفاهيم",
          },
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        "security",
        "troubleshooting",
        "versions",
      ],
    }),
  ],
});
