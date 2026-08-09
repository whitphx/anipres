---
"anipres": minor
"@anipres/agent-core": patch
---

Label timeline steps from 0 instead of 1. The number now counts advances: step N is where the presentation lands after N "next" actions, so step 0 is the un-advanced state. Under the old labels the first column read "1" while standing at zero advances, so every number was one ahead of the presses needed to reach it.

The agent's perception of the timeline and its system prompt described steps from 1 to match the old labels, and now use the same numbering, so a message like "I added a slide as step 7" points at the column the user sees. The step button also gains `type="button"`, an `aria-label` (the visible text is a bare digit) and `aria-current`.
