---
name: A gate must fail on what it cannot parse
description: A gate that only checks a field is non-empty, or silently skips a line its pattern does not match, passes the exact defect it was written for; resolve what the field claims, fail any line that does not parse, and count unrecognised values instead of dropping them.
metadata:
  type: reference
  seed: aceos-starter
---
Three shapes of the same mistake:
1. **Non-empty is not true.** A check that every row "has a source" passes rows whose cited source does not contain
   what they claim, or says the opposite. Resolve the citation: the file exists, the section exists, and it carries
   the cited item.
2. **A regex that does not match is not a pass.** A line written in a shape the pattern did not expect (two items on
   one line) is simply not seen. Require every non-blank line in the checked block to parse; an unparsable line fails.
3. **A counter that only counts what it recognises under-reports.** Values outside the expected pattern vanish from
   the tally. Count them explicitly and report them.

**Why:** these gates go green on precisely the input they exist to reject, and green is read as proof.

**How to apply:** for every gate, ask "what happens to input I did not anticipate?" The answer must be FAIL or an
explicit count, never silence. Related: [[reference_prove_a_gate_by_attacking_it]].
