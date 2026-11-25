import { COPY, type Lang } from "./copy"

// Production's site, so every stage's pages name the same canonical URLs.
const ORIGIN = "https://kumora-web.kumora.workers.dev"
const PATH = { en: "/", id: "/id" } as const satisfies Record<Lang, string>

// The landing page's title, description and language alternates. A head
// builder TanStack Router calls as is.
export const landingHead = (lang: Lang) => ({
  meta: [
    { title: COPY[lang].title },
    { name: "description", content: COPY[lang].description },
    { property: "og:title", content: COPY[lang].title },
    { property: "og:description", content: COPY[lang].description },
    { property: "og:locale", content: lang === "id" ? "id_ID" : "en_US" },
  ],
  links: [
    { rel: "canonical", href: `${ORIGIN}${PATH[lang]}` },
    { rel: "alternate", hrefLang: "en", href: `${ORIGIN}${PATH.en}` },
    { rel: "alternate", hrefLang: "id", href: `${ORIGIN}${PATH.id}` },
    { rel: "alternate", hrefLang: "x-default", href: `${ORIGIN}${PATH.en}` },
  ],
})
