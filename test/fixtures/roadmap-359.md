## Contents

- [Position](#user-content-position) — Progress and gaps
- [Forward](#user-content-forward) — From here to release
- [Lanes](#user-content-lanes) — Where the work happens
- [Gates](#user-content-gates) — What unlocks what
- [Map](#user-content-map) — See the connections

## Position

Roadmap #263 closed every child (#44–#126) and epic (#1–#30) between 2026-10-02 and 2026-10-04 with commit references, and what those merges delivered is interface, fixture and tooling work: the runtime registry and failure policy (C02), the management command contract (C05), the D2K, configuration, endpoint and lifecycle contracts (C06–C09), the package assembly inputs (C12), the qualification binaries and the operator documents. The repository's own ledgers record the acceptance side as open: `docs/architecture/project-signoff.md` keeps Gate C17 pending, the acceptance matrix keeps C13, C14, C16 and C17 and all 11 completion criteria pending, `rubix-qualification` and `rubix-release verify` fail closed, and `docs/release` is labelled unqualified fixture output. The October development-status ledger names the concrete gaps: placeholder digests for every non-Kubernetes payload row (#48), no clean-checkout build of the 16 node cells or real archives (#114, #115), no live Linux recovery, soak, performance or migration run (#119, #120, #122, #124, #125), and no operator rehearsal (#126). Underneath those gaps is an architectural one: the node that `rubix-kube` starts registers Rust in-process datastore, API server, controller manager, kube-proxy, kubelet, addons, metrics and configuration API, while no crate launches kube-apiserver, kube-controller-manager, kubelet, kube-proxy or Kine and the supervised containerd adapter is not registered; the ADR, compatibility contract, acceptance matrix and agent guidance still describe the supervised-executable boundary, whose only live evidence is the 2026-09-27 arm64 spike, and the in-process node has run only on macOS with podman (PR #333). This roadmap exists to decide that boundary, obtain real candidate bytes, run the node on Linux, make qualification evidence readable, and carry the candidate through qualification to a published release.

## Forward

The phase opens with one decision, E31.01 (#335), which amends the ADR and the contracts to say what a production Linux node runs; it releases the scoped outputs of the payload, node, runtime and migration lanes, while payload pins, the Linux CI job scaffold, the containerd runtime provider and the receipt schema proceed in parallel without waiting for it. Real digests for images, CNI, containerd, crun and shim (#338) and a clean-checkout arm64/glibc cell (#339) form the production payload cell (G02). The protected datastore and API boundary comes up on a disposable Linux arm64 runner with positive and negative mTLS evidence (#341, G03), then the workload path with runtime, CNI bridge, kubelet, kube-proxy and DNS (#342), produced by a repeatable integration job (#343), which together form the running Linux node (G04). A candidate-bound receipt schema and reader (#348) and receipt-bound release assembly (#349) form the trusted-receipts gate (G05), so that every later result is accepted only when it binds to the exact candidate digests. Once G04 holds, the five qualification runs (conformance, recovery and soak, performance, migration, addons and D2K) run in parallel against the candidate bytes and converge with the runtime epic (#344) at the qualified-candidate gate (G06); any change to candidate bytes reopens the affected receipts. The release lane then runs the fresh-operator rehearsal (#357) and publishes the exact qualified artifacts with `rubix-qualification` passing (#358), closing Gate G07 and recording C17 in the signoff document.

## Lanes

Snapshot: 2026-10-05, source `main` at 621dcfef, open PR #333. The period runs from the snapshot until G07 passes; no calendar end date is set. `depends_on` gates entry to a track; later acceptance is gated separately. `ready` includes useful design, implementation, and fixture work. Membership lists are not numeric execution order; arrows show the stated local sequence.

| Lane | State | Opens from | Membership, local sequence | Note |
| --- | --- | --- | --- | --- |
| T00 October baseline | complete | — | #1–#30, #31–#126, #192, #210, #263 | Delivered interfaces, fixtures and tooling. Production acceptance remains open and is carried by T01–T07. |
| T01 boundary and ledgers | active | T00 | #334: #335 → #336 | #335 is gate G01. Owns the ADR, compatibility contract, acceptance matrix, `AGENTS.md`, the restored development-status ledger and the #263 disposition. |
| T02 payload bytes and cells | ready | T00 | #337: #338 → #339 | Image, CNI, containerd, crun and shim pins start now; Kubernetes executable rows follow G01. #339's arm64/glibc cell is a G02 input; the remaining matrix is released by G02. |
| T03 Linux live node | ready | T00 | #340: #343 now; #341 → #342 after G01 | Owns `crates/rubix-kube/src/runtime.rs` and `.github/workflows/integration.yml`. #341 is the G03 input; #342 and #343 are G04 inputs. |
| T04 CRI runtime path | ready | T00 | #344: #345 now; #346 scope after G01 | Owns `crates/rubix-kubelet` and the apiserver pod surfaces #346 names. The containerd provider wraps the generated `rubix_cri::CriClient`; its live assertion waits for G04. |
| T05 trusted evidence import | ready | T00 | #347: #348 → #349 | Owns `tools/dev/src/release_qualification` and `docs/release`. The receipt schema is the contract T03 and T06 adopt; land it early. |
| T06 live qualification | blocked | G04 | #350: #351, #352, #353, #354, #355 in parallel | Suite selection, exclusion lists and Go reference preparation can start now; runs need the Linux node and candidate bytes. amd64 hardware is an explicit gap. #354 scope follows G01. |
| T07 operator handoff and release | blocked | G06 | #356: #357 → #358 | A dry run of #357 is released by G04; the final run and publication wait for G06. Publication needs an authorized destination and version policy. |

> Five lanes can take bounded work now: T01–T05. T06 opens after G04 and T07 after G06; both have preparatory work that can start now and is listed in their notes.

## Gates

`requires` is AND; `unlocks` releases each listed output. A track reference such as T02 requires all track acceptance work. `#N:milestone` identifies a narrower named output and does not require whole-issue closure. Gates do not automatically close issues.

| Gate | Requires (AND) | Unlocks |
| --- | --- | --- |
| G01 boundary decision | #335 | #338:kubernetes-rows, #341:scope, #342:scope, #346:scope, #354:scope |
| G02 production payload cell | #338, #339:arm64-cell | #339:remaining-matrix, #342:candidate-bytes, #350:candidate-runs |
| G03 protected live API on Linux | G01, #341 | #342, #355:api-clients |
| G04 running Linux node | G03, #342, #343 | #351, #352, #353:rust-measurements, #354:live-rehearsal, #355, #357:rehearsal-start |
| G05 trusted receipts | #348, #349 | #350:report-bindings, #358:qualification-run |
| G06 qualified candidate | G02, G04, G05, #344, #351, #352, #353, #354, #355 | #357:final, #358 |
| G07 release complete | T01, T02, T03, T04, T05, T06, T07, #357, #358 | completion |

> Completion requires G07 and every completion criterion in the "Release completion audit (Roadmap #263)" section of `docs/architecture/acceptance-matrix.md` (criteria 1–11), including publication of the exact qualified supported release and Gate C17 recorded as passed in `docs/architecture/project-signoff.md`. Criteria map to epics as follows: 1 and 2 → #334 and #340; 3 and 10 → #337 and #347; 4–8 → #350 with #344; 9 → #347; 11 → #356.

## Map

Three maps split the graph by work area. Handoff nodes carry edges across maps; a node named `handoff` on one map is the same gate on another. Rendering of `swimlane-beta` could not be checked from this environment; the tables above are authoritative if a diagram does not render.

### Map 1 — Foundations, payload and evidence (T01, T02, T05)

```mermaid
swimlane-beta LR
  subgraph T01["T01 - Boundary and ledgers (active)"]
    s01("T01 - Work opens now")
    i335["#335 ADR amendment"]
    g01{"G01 - Boundary decision"}
    i336["#336 Ledger restore and #263 disposition"]
    d01(["T01 - Track acceptance"])
  end
  subgraph T02["T02 - Payload bytes and cells (ready)"]
    s02("T02 - Work opens now")
    i338["#338 Non-Kubernetes digests"]
    i338k["#338:kubernetes-rows"]
    i339a["#339:arm64-cell"]
    g02{"G02 - Production payload cell"}
    i339r["#339:remaining-matrix"]
    d02(["T02 - Track acceptance"])
  end
  subgraph T05["T05 - Trusted evidence import (ready)"]
    s05("T05 - Work opens now")
    i348["#348 Receipt schema and reader"]
    i349["#349 Receipt-bound release assembly"]
    g05{"G05 - Trusted receipts"}
    d05(["T05 - Track acceptance"])
  end
  subgraph H1["Handoffs to Map 2 and Map 3"]
    h01("G01 to Map 2: #341:scope, #342:scope, #346:scope; to Map 3: #354:scope")
    h02("G02 to Map 2: #342:candidate-bytes; to Map 3: #350:candidate-runs")
    h05("G05 to Map 3: #350:report-bindings, #358:qualification-run")
  end
  s01 --> i335 --> g01 --> i336 --> d01
  g01 -- unlocks --> i338k
  g01 -- unlocks --> h01
  s02 --> i338 --> i339a --> g02 --> i339r --> d02
  i338k --> i339a
  g02 -- unlocks --> h02
  s05 --> i348 --> i349 --> g05 --> d05
  g05 -- unlocks --> h05
```

### Map 2 — Linux node and runtime (T03, T04)

```mermaid
swimlane-beta LR
  subgraph H2in["Handoffs from Map 1"]
    h01in("G01 - Boundary decision (Map 1)")
    h02in("G02 - Production payload cell (Map 1)")
  end
  subgraph T03["T03 - Linux live node (ready)"]
    s03("T03 - Work opens now")
    i343["#343 Disposable Linux node job"]
    i341["#341 Protected datastore and API on Linux"]
    g03{"G03 - Protected live API on Linux"}
    i342["#342 Runtime, CNI, kubelet, kube-proxy, DNS"]
    g04{"G04 - Running Linux node"}
    d03(["T03 - Track acceptance"])
  end
  subgraph T04["T04 - CRI runtime path (ready)"]
    s04("T04 - Work opens now")
    i345["#345 CriRuntimeProvider over rubix_cri"]
    i346["#346 Kubelet and apiserver workload gaps"]
    d04(["T04 - Track acceptance (#344)"])
  end
  subgraph H2out["Handoffs to Map 3"]
    h04("G04 to Map 3: #351, #352, #353:rust-measurements, #354:live-rehearsal, #355, #357:rehearsal-start")
    h44("#344 accepted to Map 3: G06 input")
  end
  s03 --> i343 --> g04
  h01in -- "unlocks #341:scope" --> i341
  i341 --> g03
  h01in -- requires --> g03
  g03 -- unlocks --> i342
  h01in -- "unlocks #342:scope" --> i342
  h02in -- "unlocks #342:candidate-bytes" --> i342
  i342 --> g04 --> d03
  g04 -- unlocks --> h04
  s04 --> i345 --> i346 --> d04
  h01in -- "unlocks #346:scope" --> i346
  i345 -. "provider used by #342 under option B" .-> i342
  g04 -. "live assertion for #345" .-> i345
  d04 --> h44
```

### Map 3 — Qualification and release (T06, T07)

```mermaid
swimlane-beta LR
  subgraph H3in["Handoffs from Map 1 and Map 2"]
    h01q("G01 - Boundary decision (Map 1)")
    h02q("G02 - Production payload cell (Map 1)")
    h05q("G05 - Trusted receipts (Map 1)")
    h04q("G04 - Running Linux node (Map 2)")
    h44q("#344 - Runtime epic accepted (Map 2)")
  end
  subgraph T06["T06 - Live qualification (blocked until G04)"]
    s06("T06 - Suite selection and runbooks open now")
    i351["#351 Conformance subset"]
    i352["#352 Recovery and 24h soak"]
    i353["#353 Paired performance captures"]
    i354["#354 Live Kine migration rehearsal"]
    i355["#355 Addons, egress and D2K"]
    g06{"G06 - Qualified candidate"}
    d06(["T06 - Track acceptance (#350)"])
  end
  subgraph T07["T07 - Operator handoff and release (blocked until G06)"]
    s07("T07 - Dry run after G04")
    i357["#357 Fresh-operator rehearsal"]
    i358["#358 Publish and record C17"]
    g07{"G07 - Release complete"}
    done(["Completion: criteria 1-11"])
  end
  s06 --> i351
  s06 --> i352
  s06 --> i353
  s06 --> i354
  s06 --> i355
  h04q -- unlocks --> i351
  h04q -- unlocks --> i352
  h04q -- "unlocks #353:rust-measurements" --> i353
  h04q -- "unlocks #354:live-rehearsal" --> i354
  h04q -- unlocks --> i355
  h01q -- "unlocks #354:scope" --> i354
  h02q -- "unlocks #350:candidate-runs" --> s06
  h05q -- "unlocks #350:report-bindings" --> g06
  i351 --> g06
  i352 --> g06
  i353 --> g06
  i354 --> g06
  i355 --> g06
  h02q -- requires --> g06
  h04q -- requires --> g06
  h44q -- requires --> g06
  g06 --> d06
  h04q -- "unlocks #357:rehearsal-start" --> s07
  s07 --> i357
  g06 -- "unlocks #357:final" --> i357
  g06 -- unlocks --> i358
  h05q -- "unlocks #358:qualification-run" --> i358
  i357 --> i358 --> g07 --> done
```
