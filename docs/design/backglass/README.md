# Backglass: the approved design

The chosen look for the Veto app: a 1930s brass and forest-lacquer pinball cabinet. Calm by default; it powers up only at the moments that matter (a refusal, the refusal count, a rule going live). Logo: Catch, a brass V holding an amber ball that cannot fall through. The ball is the request, the V is the rule that caught it.

- `screens/`: every approved screen rendered at phone size (390x844), plus the stickiness mockups (ST1 to ST6) and the strategy board (ST0).
- `html/`: the source mockup for each screen. Read it for exact colors, spacing, copy and motion. Open in a browser; motion is CSS only.
- `app/assets/brand/`: the logo kit (SVG masters, app icon, adaptive icon, splash, favicons) and `usage.md`.

The app on main follows this map. The bottom tabs are labeled Overview, Rules, Agents, and Decisions. Overview is the home screen (FD3). First run uses the five stages Learn, Connect wallet, Add your agent, Approve the rule, and Live. Grades, plaques, the week in review, the track record card, renewal, the quiet note, the widget, and the Hold screens are in the app. The agent package is `@veto-hq/agent-sdk`, published to npm at 0.1.0 on 2026-09-27. Authorize identifies the app as `https://veto-hq.github.io`. Hold is merged and tested, and live on devnet. The app screens exist. A completed device check of Hold with a real vault is not recorded in this repository yet.

Build rules:

- Copy on screen is final wording. Keep it: every number says what it is and whose it is, no jargon on screen.
- Numbers in the mockups are sample data. In the app every number comes from the chain.
- Colors: forest #0F1A16, surface #16231E, bone #EDE6D6, muted #93A097, brass #C9A24D, deep brass #7E5E14, amber ball #E3C77E. Fonts: Fraunces (display and numbers), Manrope (body).
- Honour the system reduced-motion setting: every animation has a still end state.

Screen map (flow order):

| Flow | Screens |
|---|---|
| First run: learn | FD1 Welcome, FD6 to FD8 How it works 2 to 4, FD19 How Veto works |
| First run: set up | FD9 Connect, FD20 Wallet connected, FD21 Add agent, FD22 Name agent, FD2 Approve, FD5 Rule live, FD23 Connect agent, FD24 Alerts |
| Daily use | FD3 Home, FD4 Refusal, FD13 Rules, FD12 Rule detail, FD11 New rule, FD10 Scan |
| Records and help | FD14 Decisions, FD15 Decision detail, FD16 Share, FD17 Help, FD18 Rule stopped |
| Staying with Veto | ST1 Widget, ST2 Week in review, ST3 Plaques, ST4 Track record card, ST5 Renewal, ST6 Quiet note |
| Agents and grades | FD25 Agents (new fourth tab), FD26 Agent record, FD27 How grades work |
| Hold (vault) | VT0 proposal board, VT1 Set up vault, VT2 Guardian, VT3 Held withdrawal, VT4 Alert plan, VT5 Frozen, VT6 Skip with both keys |
