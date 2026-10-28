import { describe, expect, test } from "bun:test";
import type { Finding } from "../../src/core/index.js";
import { scanHtml } from "../../src/core/index.js";
import { isClean } from "../../src/core/policy.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

/** Static page (no scripts) with visible framing. */
const page = (body: string, head = "") =>
  `<!DOCTYPE html>\n<html>\n<head><title>Docs</title>${head}</head>\n<body>\n<h1>Getting started</h1>\n<p>Install the package and run the setup script.</p>\n${body}\n</body>\n</html>\n`;
/** Same page with a script: toggleable UI can be revealed. */
const scriptedPage = (body: string, head = "") => page(body, `${head}<script src="/app.js" defer></script>`);

const hidden = (fs: Finding[]) => fs.filter((f) => f.ruleId === "html/hidden-text");
const hiddenTexts = (fs: Finding[]) => hidden(fs).map((f) => f.hiddenText);
const ruleIds = (fs: Finding[]) => fs.map((f) => f.ruleId);

/** Assert exactly one hidden-text finding for NEUTRAL on a static page (warning). */
function expectHiddenProse(html: string) {
  const fs = scanHtml(html);
  const h = hidden(fs);
  expect(h.map((f) => f.hiddenText)).toEqual([NEUTRAL]);
  expect(h[0].severity).toBe("warning");
  return h[0];
}

function expectVisible(html: string) {
  const fs = scanHtml(html);
  expect(hiddenTexts(fs)).toEqual([]);
}

describe("baseline", () => {
  test("visible page is clean with no findings", () => {
    expect(scanHtml(page("<p>Welcome to the docs. Everything here is visible.</p>"))).toEqual([]);
  });

  test("hidden instruction is critical", () => {
    const fs = scanHtml(page(`<p style="display:none">${PAYLOAD}</p>`));
    expect(hidden(fs)).toHaveLength(1);
    expect(hidden(fs)[0].severity).toBe("critical");
    expect(hidden(fs)[0].intent).toBe("instruction");
  });

  test("hidden finding carries a line number and H/A views", () => {
    const f = expectHiddenProse(page(`<p style="display:none">${NEUTRAL}</p>`));
    expect(f.line).toBe(7);
    expect(f.agentView).toContain("appendix B");
    expect(f.humanView).not.toContain("appendix B");
  });

  test("<title> is not reported", () => {
    expect(scanHtml(`<html><head><title>${NEUTRAL}</title></head><body><p>Hi.</p></body></html>`)).toEqual(
      [],
    );
  });

  test("script and style contents are not text", () => {
    expect(
      scanHtml(page(`<script>var s = "${NEUTRAL}";</script><style>.x::after{content:"${NEUTRAL}"}</style>`)),
    ).toEqual([]);
  });
});

describe("CSS cascade", () => {
  test("stylesheet class rule", () => {
    expectHiddenProse(page(`<p class="note">${NEUTRAL}</p>`, "<style>.note{display:none}</style>"));
  });

  test("stylesheet id rule with visibility:hidden", () => {
    expectHiddenProse(page(`<div id="x">${NEUTRAL}</div>`, "<style>#x { visibility: hidden }</style>"));
  });

  test("hiding is inherited through ancestors", () => {
    const f = expectHiddenProse(page(`<div style="display:none"><section><p>${NEUTRAL}</p></section></div>`));
    expect(f.detail).toBe("display:none");
  });

  test("visibility:visible on a child re-shows it", () => {
    expectVisible(page(`<div style="visibility:hidden"><p style="visibility:visible">${NEUTRAL}</p></div>`));
  });

  test("inline style beats a stylesheet rule", () => {
    expectVisible(
      page(`<p class="note" style="display:block">${NEUTRAL}</p>`, "<style>.note{display:none}</style>"),
    );
  });

  test("!important in a stylesheet beats inline style", () => {
    expectHiddenProse(
      page(
        `<p class="note" style="display:block">${NEUTRAL}</p>`,
        "<style>.note{display:none !important}</style>",
      ),
    );
  });

  test("higher specificity wins regardless of order", () => {
    expectHiddenProse(
      page(`<p id="a" class="b">${NEUTRAL}</p>`, "<style>#a{display:none} .b{display:block}</style>"),
    );
    expectVisible(
      page(`<p id="a" class="b">${NEUTRAL}</p>`, "<style>#a{display:block} .b{display:none}</style>"),
    );
  });

  test("later rule wins at equal specificity", () => {
    expectVisible(page(`<p class="b">${NEUTRAL}</p>`, "<style>.b{display:none} .b{display:block}</style>"));
    expectHiddenProse(
      page(`<p class="b">${NEUTRAL}</p>`, "<style>.b{display:block} .b{display:none}</style>"),
    );
  });

  test("CSS comment inside a declaration does not evade", () => {
    expectHiddenProse(page(`<p style="display:/**/none">${NEUTRAL}</p>`));
  });

  test(":hover rules are ignored (not the default rendering)", () => {
    expectVisible(page(`<p class="t">${NEUTRAL}</p>`, "<style>.t:hover{display:none}</style>"));
  });

  test("@media print rules are ignored", () => {
    expectVisible(page(`<p class="t">${NEUTRAL}</p>`, "<style>@media print { .t{display:none} }</style>"));
  });

  test("@media screen rules apply", () => {
    expectHiddenProse(
      page(`<p class="t">${NEUTRAL}</p>`, "<style>@media screen { .t{display:none} }</style>"),
    );
  });
});

describe("hiding techniques", () => {
  test("hidden attribute", () => {
    expectHiddenProse(page(`<div hidden>${NEUTRAL}</div>`));
  });

  test("opacity is cumulative across ancestors", () => {
    const f = expectHiddenProse(
      page(`<div style="opacity:0.2"><div style="opacity:0.2"><p>${NEUTRAL}</p></div></div>`),
    );
    expect(f.detail).toMatch(/opacity/);
  });

  test("a single opacity:0.2 is visible", () => {
    expectVisible(page(`<p style="opacity:0.2">${NEUTRAL}</p>`));
  });

  test("opacity:0.01", () => {
    expectHiddenProse(page(`<p style="opacity:0.01">${NEUTRAL}</p>`));
  });

  test("font-size:1px", () => {
    expectHiddenProse(page(`<p style="font-size:1px">${NEUTRAL}</p>`));
  });

  test("em font sizes compound", () => {
    expectHiddenProse(
      page(`<div style="font-size:0.1em"><span style="font-size:0.5em">${NEUTRAL}</span></div>`),
    );
    expectVisible(page(`<div style="font-size:0.8em"><span style="font-size:0.9em">${NEUTRAL}</span></div>`));
  });

  test("font shorthand with tiny size", () => {
    expectHiddenProse(page(`<p style="font: 0px/1 sans-serif">${NEUTRAL}</p>`));
  });

  test("white text on the default white background", () => {
    expectHiddenProse(page(`<p style="color:#fff">${NEUTRAL}</p>`));
  });

  test("near-white text", () => {
    expectHiddenProse(page(`<p style="color:#f8f8f8">${NEUTRAL}</p>`));
  });

  test("white via hsl(), space-separated rgb() and named colours", () => {
    expectHiddenProse(page(`<p style="color:hsl(0, 0%, 100%)">${NEUTRAL}</p>`));
    expectHiddenProse(page(`<p style="color: rgb(255 255 255)">${NEUTRAL}</p>`));
    expectHiddenProse(page(`<p style="color:hsl(0 0% 100% / 1)">${NEUTRAL}</p>`));
    expectHiddenProse(page(`<p style="color:ghostwhite">${NEUTRAL}</p>`));
  });

  test("transparent text colour", () => {
    expectHiddenProse(page(`<p style="color:transparent">${NEUTRAL}</p>`));
    expectHiddenProse(page(`<p style="color:rgba(0,0,0,0)">${NEUTRAL}</p>`));
  });

  test("-webkit-text-fill-color transparent", () => {
    expectHiddenProse(page(`<p style="-webkit-text-fill-color:transparent">${NEUTRAL}</p>`));
  });

  test("text colour matching an inherited stylesheet background", () => {
    expectHiddenProse(
      page(
        `<p class="dim">${NEUTRAL}</p>`,
        "<style>body{background-color:#111;color:#eee} .dim{color:#121212}</style>",
      ),
    );
  });

  test("background shorthand is read for the colour", () => {
    expectHiddenProse(
      page(
        `<p class="dim">${NEUTRAL}</p>`,
        "<style>body{background:#111;color:#eee} .dim{color:#121212}</style>",
      ),
    );
    expectHiddenProse(
      page(`<div style="background: black no-repeat"><span style="color:#010101">${NEUTRAL}</span></div>`),
    );
  });

  test("dark theme with light text is visible", () => {
    expectVisible(
      page(`<p class="t">${NEUTRAL}</p>`, "<style>body{background:#111;color:#eee} .t{color:#ddd}</style>"),
    );
  });

  test("white text on a dark inline background is visible", () => {
    expectVisible(page(`<div style="background-color:#222"><p style="color:white">${NEUTRAL}</p></div>`));
  });

  test("background image makes contrast unknown (not reported)", () => {
    expectVisible(
      page(`<div style="background-image:url(hero.jpg)"><p style="color:#fff">${NEUTRAL}</p></div>`),
    );
    expectVisible(
      page(`<div style="background:linear-gradient(#000, #333)"><p style="color:#fff">${NEUTRAL}</p></div>`),
    );
  });

  // Regression: with a background image, contrast is unknown even when a fallback colour is set.
  test("background shorthand with an image and a fallback colour is unknown contrast", () => {
    expectVisible(
      page(`<div style="background:url(hero.jpg) #fff"><p style="color:#fff">${NEUTRAL}</p></div>`),
    );
  });

  test("legacy <font color=white>", () => {
    expectHiddenProse(page(`<font color="white">${NEUTRAL}</font>`));
  });

  test("transform: scale(0)", () => {
    expectHiddenProse(page(`<div style="transform:scale(0)">${NEUTRAL}</div>`));
  });

  test("transform: scale(0.5) is visible", () => {
    expectVisible(page(`<div style="transform:scale(0.5)">${NEUTRAL}</div>`));
  });

  test("clip-path: inset(100%)", () => {
    expectHiddenProse(page(`<span style="clip-path:inset(100%)">${NEUTRAL}</span>`));
  });

  test("clip-path: circle(0)", () => {
    expectHiddenProse(page(`<span style="clip-path:circle(0)">${NEUTRAL}</span>`));
  });

  test("height:0 with overflow:hidden", () => {
    expectHiddenProse(page(`<div style="height:0;overflow:hidden">${NEUTRAL}</div>`));
  });

  test("height:0 without overflow:hidden is visible (content overflows)", () => {
    expectVisible(page(`<div style="height:0">${NEUTRAL}</div>`));
  });

  test("off-screen absolute positioning", () => {
    expectHiddenProse(page(`<div style="position:absolute;left:-9999px">${NEUTRAL}</div>`));
    expectHiddenProse(page(`<div style="position:absolute;left:-100vw">${NEUTRAL}</div>`));
    expectHiddenProse(page(`<div style="position:absolute;top:-200%">${NEUTRAL}</div>`));
  });

  test("small negative offsets are visible", () => {
    expectVisible(page(`<div style="position:relative;left:-10px">${NEUTRAL}</div>`));
  });

  test("text-indent:-9999px", () => {
    expectHiddenProse(page(`<div style="text-indent:-9999px;overflow:hidden">${NEUTRAL}</div>`));
  });

  test("closed <dialog>", () => {
    expectHiddenProse(page(`<dialog>${NEUTRAL}</dialog>`));
    expectVisible(page(`<dialog open>${NEUTRAL}</dialog>`));
  });
});

describe("screen-reader-only text", () => {
  const SR =
    "<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}</style>";

  test("sr-only prose is a channel (info)", () => {
    const fs = scanHtml(page(`<span class="sr-only">${NEUTRAL}</span>`, SR));
    expect(hidden(fs)).toHaveLength(1);
    expect(hidden(fs)[0].severity).toBe("info");
  });

  test("sr-only instruction is still critical", () => {
    const fs = scanHtml(page(`<span class="sr-only">${PAYLOAD}</span>`, SR));
    expect(hidden(fs)[0].severity).toBe("critical");
  });

  test("sr-only skip link is clean", () => {
    expect(isClean(scanHtml(page(`<a class="sr-only" href="#main">Skip to content</a>`, SR)))).toBe(true);
  });
});

describe("scripted vs static pages", () => {
  test("scripted page: toggleable hidden prose is info", () => {
    const fs = scanHtml(scriptedPage(`<div id="cookie" hidden>${NEUTRAL}</div>`));
    expect(hidden(fs)).toHaveLength(1);
    expect(hidden(fs)[0].severity).toBe("info");
  });

  test("scripted page: toggleable hidden instruction is critical", () => {
    const fs = scanHtml(scriptedPage(`<div style="display:none">${PAYLOAD}</div>`));
    expect(hidden(fs)[0].severity).toBe("critical");
  });

  test("scripted page: non-toggleable hiding (white text) prose stays warning", () => {
    const fs = scanHtml(scriptedPage(`<p style="color:#fff">${NEUTRAL}</p>`));
    expect(hidden(fs)[0].severity).toBe("warning");
  });

  test("static page: hidden prose is a warning", () => {
    expectHiddenProse(page(`<div style="display:none">${NEUTRAL}</div>`));
  });

  test("JSON/template script types do not make a page scripted", () => {
    const html = page(
      `<div style="display:none">${NEUTRAL}</div>`,
      '<script type="application/ld+json">{}</script>',
    );
    expect(hidden(scanHtml(html))[0].severity).toBe("warning");
  });

  test("staticDocument option overrides scripts", () => {
    const fs = scanHtml(scriptedPage(`<div style="display:none">${NEUTRAL}</div>`), { staticDocument: true });
    expect(hidden(fs)[0].severity).toBe("warning");
  });

  test("ordinary scripted site chrome is clean", () => {
    const html = scriptedPage(
      `<a class="sr-only" href="#main">Skip to content</a><nav><ul class="dropdown" style="display:none"><li>Home</li><li>Pricing</li><li>About</li></ul></nav><div id="cookie" hidden>We use cookies to improve your experience. Accept?</div><main id="main"><p>Welcome.</p></main>`,
      "<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>",
    );
    expect(isClean(scanHtml(html))).toBe(true);
  });
});

describe("agent-only channels", () => {
  test("HTML comments", () => {
    const fs = scanHtml(page(`<!-- ${PAYLOAD} -->`));
    const c = fs.find((f) => f.ruleId === "html/comment");
    expect(c?.severity).toBe("critical");
    expect(c?.hiddenText).toBe(PAYLOAD);
  });

  test("benign comments are info", () => {
    const fs = scanHtml(page("<!-- TODO: add examples -->"));
    expect(ruleIds(fs)).toEqual(["html/comment"]);
    expect(fs[0].severity).toBe("info");
  });

  test("comments before <html> are found", () => {
    const fs = scanHtml(`<!-- ${PAYLOAD} -->\n<!DOCTYPE html><html><body><p>Hi.</p></body></html>`);
    expect(ruleIds(fs)).toContain("html/comment");
  });

  test("image alt text", () => {
    const fs = scanHtml(page(`<img src="logo.png" alt="${PAYLOAD}">`));
    expect(fs.find((f) => f.ruleId === "html/alt-text")?.severity).toBe("critical");
  });

  test("descriptive alt text and meta description are clean", () => {
    const fs = scanHtml(
      page(
        `<img src="logo.png" alt="Acme logo">`,
        '<meta name="description" content="Acme date parsing library documentation">',
      ),
    );
    expect(isClean(fs)).toBe(true);
  });

  test("title attribute", () => {
    const fs = scanHtml(page(`<a href="/x" title="${PAYLOAD}">link</a>`));
    expect(fs.find((f) => f.ruleId === "html/title-attribute")?.severity).toBe("critical");
  });

  test("aria-label only when it differs from visible text", () => {
    const differs = scanHtml(page(`<button aria-label="${PAYLOAD}">Subscribe</button>`));
    expect(differs.find((f) => f.ruleId === "html/aria-label")?.severity).toBe("critical");
    const same = scanHtml(page(`<button aria-label="Subscribe">Subscribe</button>`));
    expect(ruleIds(same)).not.toContain("html/aria-label");
  });

  test("meta description / og tags", () => {
    const fs = scanHtml(
      page(
        "",
        `<meta name="description" content="${PAYLOAD}"><meta property="og:description" content="${PAYLOAD}">`,
      ),
    );
    expect(fs.filter((f) => f.ruleId === "html/meta").length).toBeGreaterThanOrEqual(1);
    expect(fs.find((f) => f.ruleId === "html/meta")?.severity).toBe("critical");
  });

  test("meta viewport / charset are not channels", () => {
    const fs = scanHtml(
      page("", '<meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8">'),
    );
    expect(ruleIds(fs)).not.toContain("html/meta");
  });

  test("<template>", () => {
    const fs = scanHtml(page(`<template><p>${PAYLOAD}</p></template>`));
    expect(fs.find((f) => f.ruleId === "html/template")?.severity).toBe("critical");
    expect(hidden(fs)).toEqual([]);
  });

  test("<noscript>", () => {
    const fs = scanHtml(page(`<noscript><p>${PAYLOAD}</p></noscript>`));
    expect(fs.find((f) => f.ruleId === "html/noscript")?.severity).toBe("critical");
  });

  test("closed <details> body is a channel, summary is visible", () => {
    const fs = scanHtml(page(`<details><summary>License</summary><p>${PAYLOAD}</p></details>`));
    const d = fs.find((f) => f.ruleId === "html/collapsed-details");
    expect(d?.severity).toBe("critical");
    expect(d?.hiddenText).not.toContain("License");
    expect(hidden(fs)).toEqual([]);
  });

  test("open <details> is not a channel", () => {
    const fs = scanHtml(page(`<details open><summary>FAQ</summary><p>${NEUTRAL}</p></details>`));
    expect(fs).toEqual([]);
  });

  test("collapsed FAQ answer is info", () => {
    const fs = scanHtml(
      page(`<details><summary>Does it support time zones?</summary><p>${NEUTRAL}</p></details>`),
    );
    expect(isClean(fs)).toBe(true);
  });

  test("hidden form field values", () => {
    const fs = scanHtml(page(`<form><input type="hidden" name="n" value="${PAYLOAD}"></form>`));
    expect(fs.find((f) => f.ruleId === "html/hidden-input")?.severity).toBe("critical");
  });
});

describe("SVG", () => {
  const svg = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="#336"/><text x="5" y="25" fill="#fff">ACME</text>${inner}</svg>\n`;

  test("fill-opacity 0 hides text", () => {
    const fs = scanHtml(svg(`<text x="5" y="35" fill-opacity="0">${NEUTRAL}</text>`), {
      xml: true,
      staticDocument: true,
    });
    const h = fs.filter((f) => f.ruleId === "svg/hidden-text");
    expect(h.map((f) => f.hiddenText)).toEqual([NEUTRAL]);
    expect(h[0].severity).toBe("warning");
  });

  test("fill=none hides text", () => {
    const fs = scanHtml(svg(`<text x="5" y="35" fill="none">${PAYLOAD}</text>`), {
      xml: true,
      staticDocument: true,
    });
    expect(fs.find((f) => f.ruleId === "svg/hidden-text")?.severity).toBe("critical");
  });

  test("visible SVG text is clean", () => {
    const fs = scanHtml(svg(""), { xml: true, staticDocument: true });
    expect(fs).toEqual([]);
  });

  test("<desc> and <title> are metadata channels", () => {
    const fs = scanHtml(svg(`<title>Logo</title><desc>${PAYLOAD}</desc>`), {
      xml: true,
      staticDocument: true,
    });
    expect(fs.filter((f) => f.ruleId === "svg/svg-metadata").length).toBe(2);
    expect(fs.some((f) => f.ruleId === "svg/svg-metadata" && f.severity === "critical")).toBe(true);
  });

  test("inline SVG in HTML honours fill-opacity", () => {
    const fs = scanHtml(page(`<svg><text fill-opacity="0">${NEUTRAL}</text></svg>`));
    expect(hiddenTexts(fs)).toEqual([NEUTRAL]);
  });
});

describe("rule prefix and source mapping", () => {
  test("rulePrefix renames rules", () => {
    const fs = scanHtml(page(`<p style="display:none">${NEUTRAL}</p>`), { rulePrefix: "markdown" });
    expect(ruleIds(fs)).toEqual(["markdown/hidden-text"]);
  });

  test("source option locates lines by searching for the hidden text", () => {
    const source = `line one\nline two\n<p style="display:none">${NEUTRAL}</p>\n`;
    const fs = scanHtml(`<p style="display:none">${NEUTRAL}</p>`, { source });
    expect(fs[0].line).toBe(3);
  });
});
