# Assets for the explainer videos: brand marks and icons

The shorts renderer (`scripts/shorts/`, see [shorts.md](shorts.md)) can show real product marks
and a set of generic icons. They live in `scripts/shorts/page/assets/`:

- `brands/*.svg`: brand marks we may show, as optimised SVGs in the colours their owners permit
- `icons/*.svg`: generic line icons that take the board's colours, plus `icons/LICENSE-lucide.txt`
- `manifest.json`: the machine-readable record (id, file, kind, owner, licence, source, guideline
  URL, `allowed`, the owner's rules). The renderer reads it and refuses anything it does not allow.

Checked on 2026-10-31. Brand guidelines change: re-check a brand's page before a video that
uses its mark is published, and update the manifest if the rules moved.

## The rule

1. **Identify, never decorate.** A brand mark appears only to identify the product the video is
   talking about at that moment. No logo walls, no backgrounds, no "as used by" rows.
2. **Never imply endorsement or partnership.** Nothing on screen or in the narration may suggest
   that the owner made, sponsors, approves or works with Opalix or the lab. Our own name stays more
   prominent than any brand shown.
3. **Never altered.** No recolouring (except a monochrome version the guideline itself permits),
   cropping, stretching, rotating, outlines, shadows, overlays, strike-throughs or dimming. The
   renderer keeps each file's colours, scales it in proportion, leaves clear space round it, and
   refuses a `strike` or `dim` beat on an element that shows a mark.
4. **Always with the name.** A mark is always shown with the product's name next to it (the
   renderer adds it; it cannot be switched off).
5. **When in doubt, write the name.** A brand whose owner forbids this use, or whose rules are
   unclear, is listed with `allowed: false`: write the name in text instead. A chat mock may be
   titled "ChatGPT" or "Claude" in plain text; that is a factual reference to the product.
6. **Say so at the end.** Any video that shows a mark carries the trademarks line on its end card
   (automatic) and in its video description:

   > Trademarks (GitHub, Kong and Python) belong to their owners and are used here only to identify
   > their products. No endorsement or affiliation is implied.

   With no brand marks, the short form is: *Trademarks belong to their respective owners. No
   endorsement or affiliation is implied.* Kong also asks for a line such as "This video is not
   affiliated with or otherwise sponsored by Kong, Inc." in the description when Kong's mark is shown.

## Brand marks

| Brand | Use? | Colour on navy | Source | Guideline and the rule that decides |
|---|---|---|---|---|
| GitHub | **yes** | white (permitted: white, black, rarely grey/green) | `simple-icons@16.36.0` (CC0 drawing; trademark applies) | [brand.github.com](https://brand.github.com/foundations/logo): "Use the logo in content about GitHub" is a listed *Do*; don't change colour or dimensions, don't combine with other elements, don't imply GitHub made or endorses our work. Only in a video about something on GitHub. |
| Kong | **yes** | electric lime `#ccff00`, as supplied | Kong press kit, "For Dark Backgrounds / Kong-Logomark.svg", from konghq.com | [konghq.com/brand](https://konghq.com/brand): "You can use Kong's brand elements for educational and instructional purposes, but it should not be confusing or misleading"; "Do not edit, change, distort, recolor or reconfigure the logo". Also says "check with us before using the Kong logo on any outside websites": see *Owner decisions*. |
| Python | **yes**, only to say a program is written in Python | official blue and yellow, as supplied | python.org "logo device only" SVG (`python-logo-only.svg`) | [PSF trademarks](https://www.python.org/psf/trademarks/): "stating accurately that software is written in the Python programming language" is always allowed, with "the unaltered logos". Colour changes need permission; other commercial uses need written permission. |
| OpenAI | no: write the name | | not in simple-icons | [openai.com/brand](https://openai.com/brand/): don't use the logo "without permission or outside OpenAI's terms"; don't imply endorsement; don't modify it. Permission: partnercomms@openai.com. |
| ChatGPT | no: write the name | | | Same OpenAI terms. |
| Anthropic | no: write the name | | | [Anthropic trademark guidelines](https://www.anthropic.com/legal/trademark-guidelines): "You may only use our trademarks as specifically permitted by us and only in materials we approve beforehand." No colour or proportion changes. |
| Claude | no: write the name | | | Same Anthropic guidelines (they cover its names and logos). |
| MCP (Model Context Protocol) | no: write the name | | | [LF Projects trademark policy](https://lfprojects.org/policies/trademark-policy/) (Model Context Protocol®, MCP™): logos only as a link to the project, or with written permission in marketing; no allowance for educational use. |
| Cursor | no: write the name | | | [cursor.com/brand](https://cursor.com/brand) gives assets but no third-party terms (only "Refer to us as Cursor"). Unclear. |
| Docker | no: write the name | | | [Docker trademark guidelines](https://www.docker.com/legal/trademark-guidelines/): the educational allowance covers "word Marks (but not logo marks)"; logos only after authorisation; the whale not "in new … videos". |
| Google Gemini | no: write the name | | | [Google brand guidance](https://partnermarketinghub.withgoogle.com/brands/google/branding-guidelines/how-to-show-googles-brand/): product icons need a request "through our approval form". |
| IBM ContextForge | no: write the name | | | [IBM copyright and trademarks](https://www.ibm.com/legal/copyright-trademark): IBM logos need express written permission; fair use is text-only. No ContextForge logo guideline. |
| Cloudflare | no: write the name | | | [Cloudflare trademark](https://www.cloudflare.com/trademark/): "Use of the Cloudflare logos … requires our written permission." |
| LiteLLM | no: write the name | | | No published guideline (LITELLM application by Berri AI). Unclear. |
| PostgreSQL | no: write the name | | | [PostgreSQL trademark policy](https://www.postgresql.org/about/policies/trademarks/): the names are fine in articles; "for pretty much any use not discussed above, you must contact us for permission". |
| Jaeger | no: write the name | | | [Linux Foundation trademark usage](https://www.linuxfoundation.org/legal/trademark-usage) governs cncf/artwork: no logos in marketing without written permission; CNCF's educational clause covers its own brand. Unclear for us. |
| OpenTelemetry | no: write the name | | | Same as Jaeger. |
| Grafana | no: write the name | | | [Grafana trademark policy](https://grafana.com/trademark-policy/): open-source discussion is allowed, but not "in or on any website, promotion or marketing materials" without permission. |
| Qdrant | no: write the name | | | [Qdrant brand resources](https://qdrant.tech/brand-resources/): use "must adhere to the specified Qdrant Trademark Standards for Use", which are not published. Unclear. |
| Arize Phoenix | no: write the name | | | [arize.com/brand](https://arize.com/brand/): visual rules only, no third-party terms. Unclear. |
| Node.js | no: write the name | | | [OpenJS trademark policy](https://trademark-policy.openjsf.org/): fair use of word marks; logos only as a link to the project or with written permission. |

`simple-icons` also has drawings for Anthropic, Claude, MCP, Cursor, Docker, Gemini, Cloudflare,
PostgreSQL, Jaeger, OpenTelemetry, Grafana, Qdrant and Node.js. Its CC0 licence covers the drawing
only; as its own disclaimer says, the trademarks still apply, so those marks stay out until their
owners' rules allow this use.

## Icons

All from `lucide-static@1.66.0` (ISC; the Feather-derived ones also MIT, see
`icons/LICENSE-lucide.txt`, which must stay with the files). They draw in `currentColor`, so they
take the element's colour on either theme.

| id | lucide icon | id | lucide icon |
|---|---|---|---|
| `agent` | bot | `calendar` | calendar |
| `server` | server | `cloud` | cloud |
| `database` | database | `weather` | cloud-sun |
| `key` | key-round | `chat` | message-circle |
| `lock` | lock | `terminal` | square-terminal |
| `clock` | clock | `document` | file-text |
| `warning` | triangle-alert | `money` | banknote |

## Using them in a video

```yaml
gh:   { type: logo, id: github, size: 72, pos: [190, 210] }            # mark + "GitHub" beside it
py:   { type: logo, id: python, label: "Python 3.12", labelAt: below }  # custom name, under the mark
script: { type: chip, logo: python, font: mono, text: "call_tool.py", sub: "written in Python" }
db:   { type: node, icon: database, label: "Database" }                  # a library icon by name
srv:  { type: icon, id: server, label: server, size: 64 }               # an icon with a label
old:  { type: node, icon: server, label: "Server" }                      # built-in drawing (built-ins win)
new:  { type: node, icon: "lib:server", label: "Server" }               # the library one instead
chat: { type: chat, title: "ChatGPT", messages: [...] }                  # names in text are always fine
```

The render fails before narration with a clear message when a scene names a brand that is
missing or not allowed (`logo: chatgpt` → *"the brand "chatgpt" (ChatGPT, OpenAI) is not allowed by
its owner's guidelines: Do not use; write the name in text instead…"*), an unknown icon, a brand
id where an icon is expected (or the reverse), `label: false` on a logo, or a `strike`/`dim` beat
on an element showing a mark.

## Adding an asset

1. Read the owner's current brand or trademark guideline. Record its URL and quote the rule that
   permits (or forbids) a mark in an educational video about the product. If it is unclear, add the
   entry with `allowed: false` and the first rule "Do not use; write the name in text instead."
2. Take the SVG from `simple-icons` or `lucide-static` (npm), or from the owner's own site when the
   guideline allows it. Keep the colours the guideline permits (a monochrome file gets the
   permitted colour written into it). Optimise it (svgo) without changing how it looks.
3. Add the entry to `manifest.json` (file, source with package@version or URL, licence, owner,
   guideline, colour, rules) and a row here.
4. Run `node --test scripts/shorts/assets.test.mjs`: it checks the manifest and the files.
