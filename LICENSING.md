# Licensing

Forge is dual-licensed.

## Default: AGPL-3.0

Forge is available under the [GNU Affero General Public License, version 3](./LICENSE) at no cost. Under AGPL-3.0 you may:

- Use, study, modify, and self-host Forge for any purpose, including commercial use.
- Distribute the source or your modified versions.

**You must, in return:**

- Keep the AGPL-3.0 license and copyright notices intact in any distribution.
- If you run a modified version of Forge as a network-accessible service (e.g. a fitness app or web product that users interact with remotely), **publish your full modified source under AGPL-3.0** for those users.

This is the AGPL's network clause — the term most people mean when they say "AGPL." It exists to prevent the SaaS loophole MIT and Apache leave open.

## Commercial license (non-AGPL)

If AGPL-3.0 doesn't fit your use case — for example:

- You want to run a closed-source SaaS built on Forge without publishing your modifications.
- You're a gym chain or fitness brand wanting a white-label deployment.
- You want to integrate Forge's engine into a proprietary product.
- Your organisation's policy disallows AGPL'd dependencies.

…a separate, paid commercial license is available. Terms are negotiated case-by-case (per-seat, revenue share, or flat fee depending on scope).

**Contact:** `abrar.a@outlook.com`

A commercial license grants you the same code under terms that do not require open-sourcing your derivative work. The default AGPL-3.0 release remains available to everyone else.

## What is "Forge"?

For licensing purposes, "Forge" refers to the contents of this repository (`abraraaa/project-forge`) — the source code, the programme design (`lib/programme.js` `SESSIONS` / `EXERCISE_POOLS`), the curated exercise anatomy dataset (`lib/exercise-anatomy.js`), the rotation and progression engines, the analytics layer, and the design tokens. All of these are covered by the same dual-license terms.

## Quick FAQ

**Can I fork Forge for personal use?** Yes — AGPL-3.0 permits any personal, educational, or self-hosted use.

**Can I run an AGPL-licensed Forge as a service for my own gym?** Yes, as long as you publish your modifications back to your users under AGPL-3.0.

**Can I take Forge, close-source it, and ship it as a paid product?** No — that requires a commercial license.

**Can I copy the programme design into a different app?** The programme content (SESSIONS / pools / anatomy weights / volume targets) is part of "Forge" for licensing purposes — it's also covered. Treat it like the code.

**Why AGPL and not MIT?** MIT lets competitors take the engine into a closed product. AGPL closes that loophole. The dual-license offer above keeps the commercial path open without giving the work away.
