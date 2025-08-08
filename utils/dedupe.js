/*  utils/dedupe.js
    ----------------------------------------------------------
    Tiny helper that removes obvious word / phrase duplication
    artifacts such as
      “is located is located …”
      “Pat in Patna,na”
      “locationlocation”
----------------------------------------------------------------*/

 /**
  * Collapse immediate lexical repeats and glued-together tokens.
  *
  * @param {string} txt – Raw text that may contain duplication artefacts.
  * @returns {string}   – Cleaned-up text.
  */
export const dedupe = (txt = "") =>
  txt
    /* ── 1-word repeats (case-insensitive; spans spaces, commas, periods, semicolons) */
    .replace(/\b(\w+)(?:[,\s.;]+\1\b)+/gi, "$1")

    /* ── 2- to 3-word phrase repeats, allowing a single connector word (e.g. “in Pat in Patna”) */
    .replace(/\b((?:\w+[,\s]+){1}\w+)(?:[,\s]+\1\b)+/gi, "$1")
    .replace(/\b((?:\w+[,\s]+){2}\w+)(?:[,\s]+\1\b)+/gi, "$1")

    /* ── 4-word phrase repeats (rare but cheap to catch) */
    .replace(/\b((?:\w+[,\s]+){3}\w+)(?:[,\s]+\1\b)+/gi, "$1")

    /* ── Glued words or duplicated suffixes: “Patna,na”, “locationlocation” */
    .replace(/\b(\w{3,})\W*\1\b/gi, "$1")

    .trim();

/* Optional default export so front-end & back-end can `import dedupe from ...` */
export default dedupe;
