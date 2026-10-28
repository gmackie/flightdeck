# Flightdeck process twin (first deterministic slice)

This is an **observational process model**, not a verified causal digital twin of a production app. It takes Flightdeck's measured directly-follows transition counts, normalizes outgoing transition frequencies, and computes the probability of reaching a designated goal within a bounded number of steps.

A what-if scenario can multiply the weight of a specific edge by a factor between 0 and 10. All remaining outgoing weights are renormalized. This lets a designer investigate **assumed** workflow changes but makes no claim that altering code or removing a step would actually cause the modeled probability change.

The simulator reports:
- Modeled goal reachability within N steps.
- Dead-end probability when an observed node has no outgoing transitions.
- Remaining unresolved probability at the horizon.
- Expected steps until success among modeled successful paths.

The model is deterministic, bounded at 200 edges and 40 steps, and has no LLM dependency. It does not consume private user-level event histories. See `@flightdeck/simulator`.

Future work to justify stronger conclusions: event-log-derived process mining per business object, empirical validation against holdout weeks/cohorts, credible uncertainty intervals, distribution shift monitoring, Bayesian or causal modeling, and controlled Flagship experiments. Do not report scenario simulations as experiment outcomes.
