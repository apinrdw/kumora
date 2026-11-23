# Oxfmt sorts Tailwind classes from the ui stylesheet

Oxfmt sorts Tailwind classes natively, with output identical to prettier-plugin-tailwindcss, reading the `@workspace/ui/globals.css` export as its `stylesheet`. Sorting turns off silently if the stylesheet is missing. There is no guard for that: moving the file already fails every app build.

Sites:
- `.oxfmtrc.json`

Source: none
