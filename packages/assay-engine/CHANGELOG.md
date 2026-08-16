# Changelog

## 0.2.0

Identical code to 0.1.2. Published on a new minor line because the default
ceilings changed value, and a patch number does not tell a reader to look.

0.1.2 was the route to consumers pinned below 0.2.0: under a 0.x caret range
`^0.1.1` resolves to `>=0.1.1 <0.2.0`, so a minor release on its own reaches
nobody who already depends on this package. That line is now empty, and 0.1.x
receives nothing further. Do not backport to it.

A version number only signals to whoever takes `latest`. Anyone asking for
`@lodz/assay-engine@0.1.1` by name still gets ceilings the vault program rejects,
and no numbering scheme prevents that, so 0.1.0 and 0.1.1 are deprecated on the
registry and say so at install time.

## 0.1.2

`DEFAULT_STOPE_POLICIES` published ceilings that the vault program does not
agree with. The program is the authority: `RiskProfile::max_emissions_bps` and
`RiskProfile::max_counterparty_bps` in `lodz-vault`, enforced on registration and
on every reallocation.

| Profile | Ceiling | 0.1.0 and 0.1.1 | Program | 0.1.2 |
|---|---|---|---|---|
| `conservative` | counterparty | 0 | 0 | 0 |
| `balanced` | counterparty | **1500** | 0 | **0** |
| `aggressive` | counterparty | **4000** | 3000 | **3000** |
| `conservative` | emissions | 2000 | 2000 | 2000 |
| `balanced` | emissions | **4000** | 5000 | **5000** |
| `aggressive` | emissions | **7000** | 10000 | **10000** |

Two separate faults, and they fail in opposite directions.

The counterparty rows were **above** the program's ceiling. An allocation derived
from the balanced or aggressive defaults could exceed what the chain accepts, and
the transaction is rejected with `CounterpartyAllocationExceeded`. The balanced
row is the sharper case: the program admits no counterparty exposure at all
there, so this package was describing a position that cannot exist.

The emissions rows were **below** it. That is not the safe direction. A ceiling
answers how much exposure is possible, so a lower number here did not restrain
any vault; it led anyone reading `DEFAULT_STOPE_POLICIES` to under-report how far
a stope is permitted to go. Read the aggressive row as written: 10000 bps is all
of it, and an aggressive stope may sit entirely on yield that has an end date.

### What changes for callers

`deriveStopeAllocation` and `projectYield` take these policies as their default
argument, so any call that did not pass an explicit `policies` or `stopePolicies`
table now returns different numbers for the balanced and aggressive profiles.
Callers who passed their own table are unaffected.

The six values are now pinned by exact assertions. The previous tests compared
with `<=`, which is why a wrong ceiling produced no failure and this went out in
two releases.
