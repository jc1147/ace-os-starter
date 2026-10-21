---
name: Verify a dashboard by looking at it
description: Dashboard and visual changes are verified by rendering and reading a screenshot the way a person would, with the specific card enlarged enough to read, then confirming exact values from the DOM; DOM text extraction alone misses clipping, overflow and broken charts.
metadata:
  type: feedback
  seed: aceos-starter
---
For any change to the Ace OS dashboard or another visual surface:
1. Render at the width the person actually uses.
2. Get a readable shot of the specific card or panel: enlarge or isolate it, then Read the image.
3. Then re-read the DOM for exact values: small text in a screenshot can be misread too.

**Why:** a DOM check passes clipped text, overflow, ugly layouts and a chart that ignores its filter. A full-page
screenshot of a wide dashboard is too small to read narrow cards. Each method alone misleads; together they hold.

**How to apply:** do both before saying a visual change is done, and use the dashboard like a person would (scroll,
click, hover) when the change is interactive. Related: [[feedback_grep_is_not_a_visual_audit]].
