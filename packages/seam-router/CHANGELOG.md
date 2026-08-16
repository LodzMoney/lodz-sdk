# Changelog

## 0.2.0

Identical code to 0.1.2. Published on a new minor line because the default
emissions ceilings changed value, and a patch number does not tell a reader to
look.

0.1.2 was the route to consumers pinned below 0.2.0: under a 0.x caret range
`^0.1.1` resolves to `>=0.1.1 <0.2.0`, so a minor release on its own reaches
nobody who already depends on this package. That line is now empty, and 0.1.x
receives nothing further. Do not backport to it.

A version number only signals to whoever takes `latest`. Anyone asking for
`@lodz/seam-router@0.1.1` by name still gets ceilings lower than the vault
program enforces, and no numbering scheme prevents that, so 0.1.0 and 0.1.1 are
deprecated on the registry and say so at install time.

## 0.1.2

`DEFAULT_CONSTRAINTS` published emissions ceilings lower than the ones the vault
program enforces. The program is the authority: `RiskProfile::max_emissions_bps`
in `lodz-vault`.

| Profile | Ceiling | 0.1.0 and 0.1.1 | Program | 0.1.2 |
|---|---|---|---|---|
| `conservative` | emissions | **1500** | 2000 | **2000** |
| `balanced` | emissions | **3500** | 5000 | **5000** |
| `aggressive` | emissions | **6000** | 10000 | **10000** |
| `conservative` | counterparty | 0 | 0 | 0 |
| `balanced` | counterparty | 0 | 0 | 0 |
| `aggressive` | counterparty | 3000 | 3000 | 3000 |

Understating a ceiling is not the cautious direction. A ceiling answers how much
exposure is possible, so a lower number here did not restrain any vault; it led
anyone reading `DEFAULT_CONSTRAINTS` to under-report how far a stope is permitted
to go. Read the aggressive row as written: 10000 bps is all of it, and that
posture permits a book funded entirely by emissions.

House risk appetite belongs in the allocation a router actually produces, not in
an understated limit.

The counterparty rows were already correct and are unchanged.

### What changes for callers

Any call that did not override `constraints.profiles.*.maxEmissionsBps` now
allows more capital into emission-funded seams before the emissions cap binds.
For the aggressive profile the cap can no longer bind at all, because 10000 bps
is the whole book; the binding constraint there moves to the risk-tier budget.
Callers who passed their own constraints are unaffected.

The six ceilings are now pinned by exact assertions. The previous tests compared
with `<=`, which is why a wrong ceiling produced no failure and this went out in
two releases.

## Earlier

`balanced.maxCounterpartyBps` was 1000 in an earlier revision, which contradicted
the published stance that the balanced chamber admits no counterparty exposure.
It was brought to 0 before 0.1.1, and the program now rejects anything above 0
there outright.
