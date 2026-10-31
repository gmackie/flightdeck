# WORKSTREAM C visual review

Local synthetic `/workflows`, Google Chrome 156.0.8078.79, 2026-10-31. No browser authentication or backend required. The shared preview tab opened the route but snapshot automation timed out twice; screenshots were captured with local headless Chrome instead. The temporary review harness acknowledged `/_fd/*` locally and made **zero `/api/` requests**. No page JavaScript errors were observed. Reduced motion was enabled for capture.

Reviewed at **1440 × 1100 desktop** and **390 × 844 narrow mobile** CSS pixels:

- Desktop: compact horizontal segmented rows (~51px per hierarchy row), clear five-level demand → requisition → application → loop → assessment indentation, separate seven-stage loop and three five-stage concurrent assessments. Completed teal, active blue, waiting/paused/deferred amber, rejected red, cancelled violet, withdrawn neutral/dashed, future muted/dotted.
- Many jobs: twelve compact requisition rows, completed-only dwell percentiles/counts and separate open-age percentiles/counts per job, with parent-owned bars and outcome counts.
- Desktop dark theme retains readable segments, explicit state symbols, and differentiated future/withdrawn fills. Long labels truncate visually; full stage labels remain in accessible button names and tooltips.
- Mobile: controls and summaries wrap; lifecycle rows retain a horizontal scroll region rather than shrinking stages to unreadable slivers. The review found off-screen screen-reader age text escaping the region; containing positioned labels fixed it. Verified document width **390px**, scroll-region width **342px**, scroll-content width **944px**, and visible demo badge. Horizontal scrolling and tapping/focusing a loop stage reveal full detail in a viewport-contained tooltip. This is a horizontal-scroll layout on mobile, not a claim that every stage fits onscreen simultaneously.
- Keyboard-focused desktop stage tooltip and tapped mobile stage tooltip include full label, dwell, owner, state, reason, age; Escape dismisses. Desktop DOM has seven loop stage buttons and three separate assessment rows.

Evidence:

- [Desktop hierarchy](desktop-hierarchy.png)
- [Desktop stage details](desktop-stage-details.png)
- [Many jobs](desktop-many-jobs.png)
- [Dark theme](desktop-dark.png)
- [Narrow mobile controls](mobile-hierarchy.png)
- [Narrow mobile loop and nested assessments](mobile-loop-hierarchy.png)
- [Narrow mobile loop stage details after horizontal/vertical scrolling](mobile-stage-details.png)

Automated DOM/unit tests separately cover navigation, accessibility semantics, metric cohort separation and invalid-timestamp diagnostics. Screen-reader acceptance is still manual; screenshots do not prove it.
