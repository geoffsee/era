Contents
---
- [Position](#user-content-position) — Progress and gaps 
- [Forward](#user-content-forward) — From here to release 
- [Lanes](#user-content-lanes) — Where the work happens
- [Gates](#user-content-gates) — What unlocks what
- [Map](#user-content-map) — See the connections

Position
---
rubix-kube has progressed from architectural groundwork to substantial component implementation toward a Rust-based, single-node Kubernetes distribution with KubeSolo compatibility. Work merged into `main` establishes compatibility contracts, pinned upstream inputs, reproducible client generation, parity fixtures, and CI checks, alongside configuration and CLI handling, host preparation, asset verification, process supervision, certificate management, and datastore durability. Component integrations now cover managed and external container runtimes, API-server security, controllers, kubelet, admission policies, networking, Service routing, CoreDNS, local-path storage, and Portainer bootstrap resources. The architecture retains upstream Kubernetes and runtime executables, with Rust owning distribution configuration, lifecycle, and management. These foundations have targeted test coverage and integration evidence, but complete node startup remains unfinished: the executable currently parses, validates, and prints configuration. This roadmap builds on that foundation to connect the components into an operational distribution and establish end-to-end qualification.


Forward
---
The next phase will connect the implemented foundations into a running, qualified distribution. Initial priorities are to establish production payload provenance, verify materialization and runtime selection, and complete node startup around the accepted upstream Kubernetes processes and Kine SQLite boundary. Early runtime and command contracts will let addon, metrics, configuration, installation, container, and client-access work advance in parallel, with live acceptance following the protected API and operational-node gates. Candidate packages will become available before full packaging acceptance so installation and container integration can proceed without circular dependencies. Once the required child outputs converge, the same candidate artifacts will undergo workload compatibility, failure recovery, platform coverage, sustained soak, performance measurement, and Go-to-Rust transition rehearsals. Changes to candidate bytes will trigger renewed qualification of affected evidence. The final gates will bring those results together for a fresh-operator handoff and publication of the exact tested artifacts.


Lanes
---
Snapshot: 2026-10-02. `depends_on` gates entry to a track; later acceptance is gated separately. `ready` includes useful design, implementation, and fixture work. Membership lists are not numeric execution order; arrows show the stated local sequence.

| Lane | State | Opens from | Membership, local sequence | Note |
| --- | --- | --- | --- | --- |
| T00 baseline | complete | — | #1, #7–#18, #31–#43, #45, #51–#88, #192, #210 | Accepted architecture and merged foundations. Production acceptance remains open. |
| T01 payload / builds | ready | T00 | #48, #114; paired work | #48 is labelled blocked, but provenance investigation and build recipes can start. C01 accepts the first complete arm64/glibc production payload cell and releases remaining-matrix work. |
| T02 materialization | ready | T00 | #49 → #50; #6 after the E02/E03 consumer integration ledger | Fixtures can start now. C01 gates production materialization; C12 consumes accepted #49/#50 outputs for packaging. |
| T03 node assembly | ready | T00 | #44 first; #2, #3, #4 close on integration evidence | Owns startup and production API/component seams. C02 publishes interfaces; C03 and C04 release successive live consumers. C13 releases #2/#3 consumer integration. |
| T04 host prep | ready | T00 | #46 → #47 → #5 | Host preparation and kernel investigation can start now. C04 supplies the running-node gate for live acceptance without requiring whole-T03 closure. |
| T05 Portainer | active | T00 | #89 → #90 → #19 | Uncommitted `feat/portainer-preserve-existing-objects` work is active progress. C02 releases production-client wiring, C03 live preservation, and C04 live bootstrap. |
| T06 D2K | ready | T00 | #91 → #92 → #93 → #20 | Digest-pinned authentication probes can start now. C06 releases #92 and the #109 client contract; C04 releases live workload acceptance. |
| T07 metrics | ready | T00 | #94 → #95 → #96 → #21 | Endpoint and fixture work can start now. C02 releases runtime wiring, C03 live health probes, and C04 live diagnostics. This track builds operational metrics, not a Kubernetes metrics-server. |
| T08 config API | ready | T00 | #97 → #98 → #99 → #22 | C02 releases runtime wiring. C05 releases CLI registration; C07 joins accepted #97/#98 outputs and releases #99 plus #110 API integration. |
| T09 CLI / install | ready | T00 | #100 → #101 → #102 → #103 → #23 | Publish C05’s handler contract early. C04 releases live service/install acceptance; C12a releases #103 offline installation using candidate packages. |
| T10 containers | ready | T00 | #104 → #105 → #106 → #24 | C05 releases command registration. C04/C12a release live-instance and packaged-image work. Partial instance/endpoints outputs feed C08; lifecycle primitives feed C09 before whole-track acceptance. |
| T11 client access | ready | T00 | #107 → #108 → #109 → #25 | C05 releases command registration. C08 joins instance ownership, published endpoints, and accepted #107 to release #108. C06 supplies the D2K client contract; C10 releases #109. |
| T12 upgrade / reset | ready | T00 | #110 → (#111 and #112 in parallel) → #113 → #26 | C05 releases command registration; C07 releases API integration. C09 releases parallel upgrade/reset work; C11 releases #113 after both and #108 are accepted. Destructive policy stays here. |
| T13 packaging | ready | T00 | #115 → #116 → #117 → #27 | C12 releases #115 node-package assembly. Partial #115 packages and #116 candidate inventory feed C12a before full packaging acceptance. #117 provides publication machinery; T19 performs the qualified supported release. |
| T14 workload qual | ready | T00 | #118 | Fixtures and suite selection can start now. C13 releases final digest-bound candidate runs. Accepted #118 joins #119 at C14. |
| T15 recovery qual | ready | T00 | #119 | Fixtures can start now. C13 releases final candidate runs. Owns separate suites/resources from T14; accepted #119 joins #118 at C14. |
| T16 platform matrix | blocked | C14 | #120 joins accepted #118/#119; #28 additionally closes prerequisite epic ledgers | Platform coverage and sustained soak follow the qualification pair. Accepted T16 evidence feeds C15. Missing hardware remains an explicit gap. |
| T17 performance | ready | T00 | #121 → #122 → #123 → #29 | Design and Go reference runs can start now. C04 releases Rust measurements; C13 releases final candidate runs. C15 additionally gates #29 final acceptance. Accepted T17 evidence feeds C16. |
| T18 Go-to-Rust | ready | T00 | #124 → #125 | Design and inventory can start now. C13 releases transition runs; C15 releases #125 final recovery rehearsal. Accepted transition/recovery evidence feeds C16 using the same candidate bytes as platform/performance reports. |
| T19 operator release | blocked | C16 | #126 → #30 | Verifies fresh-operator handoff and publishes the exact qualified artifacts. Accepted T19 evidence contributes to C17. |

> Seventeen lanes can take bounded work now: T01–T15 and T17–T18. T16 opens after C14; T19 opens after C16. GitGraph commit order within a lane is illustrative; the explicit requirements below define the gates.


Gates
---
`requires` is AND; `unlocks` releases each listed item. A track reference such as T02 requires all track acceptance work. `#N` identifies an accepted child deliverable or epic acceptance ledger when required. `#N:milestone` identifies the narrower named output and does not require whole-issue closure. Gates do not automatically close issues.

| Gate | Requires (AND) | Unlocks |
| --- | --- | --- |
| C01 production payload cell | #48:production-cell, #114:acquisition-recipe | #49:production-materialization, #114:remaining-matrix |
| C02 runtime interfaces | #44:runtime-contract | #89:production-client, #92:runtime-wiring, #94:runtime-wiring, #97:runtime-wiring, #101:runtime-wiring |
| C03 protected live API | C02, #49:materialized-core, #44:protected-api | #89:live-preservation, #95:live-health-probes |
| C04 running production node | C03, #46:prepared-host, #50:runtime-selection, #44:live-node | #90:live-bootstrap, #93:live-workload, #96:live-diagnostics, #101:live-service, #102:live-install, #104:live-instances, #121:rust-measurements |
| C05 CLI command contract | #100:command-contract | #99:command-registration, #104:command-registration, #107:command-registration, #110:command-registration, #101:service-adapters |
| C06 D2K authentication contract | #91 | #92, #109:client-contract |
| C07 safe configuration edits | #97, #98 | #99, #110:api-integration |
| C08 published client endpoints | #104:instance-contract, #105:published-endpoints, #107 | #108 |
| C09 both lifecycle backends | #101:service-contract, #106:instance-lifecycle, #110 | #111, #112 |
| C10 authenticated Docker access | C06, #93, #108 | #109 |
| C11 selective lifecycle cleanup | #111, #112, #108 | #113 |
| C12 package assembly inputs | #114:node-builds, #48, #49, #50 | #115:node-assembly |
| C12a candidate package outputs | #115:packages, #116:candidate-inventory | #103:offline-install, #104:packaged-images, #114:install-smoke, #115:install-smoke |
| C13 final candidate child outputs | C04, #44, #46, #47, #48, #49, #50, #90, #93, #96, #99, #103, #106, #109, #113, #114, #115, #116, #117 | #2:consumer-integration, #3:consumer-integration, #118:final-candidate-runs, #119:final-candidate-runs, #121:final-candidate-runs, #124:transition-runs |
| C14 workload and recovery qualification | #118, #119 | T16 |
| C15 platform and epic acceptance | T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T16 | #29:final-acceptance, #125:final-recovery-rehearsal |
| C16 exact qualified candidate | C13, C15, T14, T15, T17, T18 | T19 |
| C17 all tracks accepted | T00, T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19 | completion |

> Completion requires C17 and every completion criterion in the supplied YAML, including publication of the exact qualified supported release.


Map
---
```mermaid
%% Rubix Kube execution roadmap, transformed with Python from the supplied YAML.
%% Snapshot: 2026-10-02; source HEAD: 014b37cba8d64683a49d5cdbc85c5eb6c14764dd.
%% Conceptual gitGraph of planned work and evidence, NOT repository history.
%% Only T00 is already accepted. All later acceptance/release commits are future work.
%% Track branches are ownership lanes; C branches collect AND requirements.
%% C branches can consume partial milestones before a track or epic closes.
%% Gate merges back into a track apply to the specified outputs, not track entry.
%% Serial commits/merge collection on one lane are display order, not extra gates.
%% Merge tips may include unrelated work; each exact requires/unlocks comment is authoritative.
%% T12 upgrade/reset have separate branches to preserve the stated parallelism.
%% No dates, durations, actual merge commits, or new completion claims are inferred.
%% Syntax reference: https://mermaid.js.org/syntax/gitgraph.html
%% TRACK LEGEND (issue lists are membership, not execution order):
%% T00 | complete | Accepted architecture and merged implementation baseline | issues: #1, #7, #8, #9, #10, #11, #12, #13, #14, #15, #16, #17, #18, #31, #32, #33, #34, #35, #36, #37, #38, #39, #40, #41, #42, #43, #45, #51, #52, #53, #54, #55, #56, #57, #58, #59, #60, #61, #62, #63, #64, #65, #66, #67, #68, #69, #70, #71, #72, #73, #74, #75, #76, #77, #78, #79, #80, #81, #82, #83, #84, #85, #86, #87, #88, #192, #210
%% T01 | ready | Production payload provenance and node build matrix | issues: #48, #114
%% T02 | ready | Verified materialization and dependency selection | issues: #49, #50, #6
%% T03 | ready | Production node assembly and foundation integration | issues: #44, #2, #3, #4
%% T04 | ready | Host preparation and constrained-platform evidence | issues: #46, #47, #5
%% T05 | active | Portainer preservation and optional bootstrap | issues: #89, #90, #19
%% T06 | ready | D2K authentication and optional workload integration | issues: #91, #92, #93, #20
%% T07 | ready | Metrics and operational diagnostics | issues: #94, #95, #96, #21
%% T08 | ready | Configuration API and safe editing | issues: #97, #98, #99, #22
%% T09 | ready | Management command contract and host installation | issues: #100, #101, #102, #103, #23
%% T10 | ready | Named-container lifecycle and published endpoints | issues: #104, #105, #106, #24
%% T11 | ready | Client identity, kubeconfig and Docker access | issues: #107, #108, #109, #25
%% T12 | ready | Upgrade, reset, uninstall and state ownership | issues: #110, #111, #112, #113, #26
%% T13 | ready | Candidate packaging, attribution and publication machinery | issues: #115, #116, #117, #27
%% T14 | ready | Workload and Kubernetes compatibility qualification | issues: #118
%% T15 | ready | Restart, ownership and failure-recovery qualification | issues: #119
%% T16 | blocked | Platform matrix and sustained compatibility acceptance | issues: #120, #28
%% T17 | ready | Whole-distribution performance and memory budgets | issues: #121, #122, #123, #29
%% T18 | ready | Go-to-Rust transition and operator recovery | issues: #124, #125
%% T19 | blocked | Operator handoff and qualified supported release | issues: #126, #30
gitGraph LR:
    commit id: "T00 accepted baseline" tag: "014b37c accepted"
    branch T01_payloads
    commit id: "T01 bounded work" tag: "ready at snapshot"
    checkout main
    branch T02_materialization
    commit id: "T02 bounded work" tag: "ready at snapshot"
    checkout main
    branch T03_node
    commit id: "T03 bounded work" tag: "ready at snapshot"
    checkout main
    branch T04_host
    commit id: "T04 bounded work" tag: "ready at snapshot"
    checkout main
    branch T05_portainer
    commit id: "T05 bounded work" tag: "active at snapshot"
    checkout main
    branch T06_d2k
    commit id: "T06 bounded work" tag: "ready at snapshot"
    checkout main
    branch T07_metrics
    commit id: "T07 bounded work" tag: "ready at snapshot"
    checkout main
    branch T08_config
    commit id: "T08 bounded work" tag: "ready at snapshot"
    checkout main
    branch T09_install
    commit id: "T09 bounded work" tag: "ready at snapshot"
    checkout main
    branch T10_containers
    commit id: "T10 bounded work" tag: "ready at snapshot"
    checkout main
    branch T11_clients
    commit id: "T11 bounded work" tag: "ready at snapshot"
    checkout main
    branch T12_lifecycle
    commit id: "T12 bounded work" tag: "ready at snapshot"
    checkout main
    branch T13_packages
    commit id: "T13 bounded work" tag: "ready at snapshot"
    checkout main
    branch T14_workloads
    commit id: "T14 bounded work" tag: "ready at snapshot"
    checkout main
    branch T15_recovery
    commit id: "T15 bounded work" tag: "ready at snapshot"
    checkout main
    branch T17_performance
    commit id: "T17 bounded work" tag: "ready at snapshot"
    checkout main
    branch T18_transition
    commit id: "T18 bounded work" tag: "ready at snapshot"
    checkout T01_payloads
    commit id: "#114:acquisition-recipe"
    commit id: "#114:node-builds"
    commit id: "#48:production-cell"
    checkout T02_materialization
    commit id: "#50:runtime-selection"
    checkout T03_node
    commit id: "#44:runtime-contract"
    checkout T04_host
    commit id: "#46:prepared-host"
    checkout T09_install
    commit id: "#100:command-contract"
    commit id: "#101:service-contract"
    checkout T10_containers
    commit id: "#104:instance-contract"
    commit id: "#105:published-endpoints"
    commit id: "#106:instance-lifecycle"
    checkout T06_d2k
    commit id: "#91" tag: "planned"
    checkout T01_payloads
    commit id: "#48" tag: "planned"
    checkout T04_host
    commit id: "#46" tag: "planned"
    checkout T09_install
    commit id: "#100" tag: "planned"

    %% C01: Production payload cell
    %% requires (AND): issue:48:production-cell, issue:114:acquisition-recipe
    %% unlocks: issue:49:production-materialization, issue:114:remaining-matrix
    checkout main
    branch C01
    commit id: "C01 collect"
    %% input: issue:48:production-cell, issue:114:acquisition-recipe
    merge T01_payloads id: "C01 input 1"
    commit id: "C01" tag: "Production payload cell" type: HIGHLIGHT

    %% C02: Runtime interfaces
    %% requires (AND): issue:44:runtime-contract
    %% unlocks: issue:89:production-client, issue:92:runtime-wiring, issue:94:runtime-wiring, issue:97:runtime-wiring, issue:101:runtime-wiring
    checkout main
    branch C02
    commit id: "C02 collect"
    %% input: issue:44:runtime-contract
    merge T03_node id: "C02 input 1"
    commit id: "C02" tag: "Runtime interfaces" type: HIGHLIGHT

    %% C05: CLI command contract
    %% requires (AND): issue:100:command-contract
    %% unlocks: issue:99:command-registration, issue:104:command-registration, issue:107:command-registration, issue:110:command-registration, issue:101:service-adapters
    checkout main
    branch C05
    commit id: "C05 collect"
    %% input: issue:100:command-contract
    merge T09_install id: "C05 input 1"
    commit id: "C05" tag: "CLI command contract" type: HIGHLIGHT

    %% C06: D2K authentication contract
    %% requires (AND): issue:91
    %% unlocks: issue:92, issue:109:client-contract
    checkout main
    branch C06
    commit id: "C06 collect"
    %% input: issue:91
    merge T06_d2k id: "C06 input 1"
    commit id: "C06" tag: "D2K authentication contract" type: HIGHLIGHT
    checkout T01_payloads
    merge C01 id: "C01 enables #114:remaining-matrix"
    commit id: "#114:remaining-matrix"
    checkout T02_materialization
    merge C01 id: "C01 enables #49:production-materialization"
    commit id: "#49:production-materialization"
    checkout T03_node
    merge C02 id: "C02 enables #44:protected-api"
    commit id: "#44:protected-api"
    checkout T05_portainer
    merge C02 id: "C02 enables #89:production-client"
    commit id: "#89:production-client"
    checkout T06_d2k
    merge C02 id: "C02 enables #92:runtime-wiring"
    commit id: "#92:runtime-wiring"
    checkout T07_metrics
    merge C02 id: "C02 enables #94:runtime-wiring"
    commit id: "#94:runtime-wiring"
    checkout T08_config
    merge C02 id: "C02 enables #97:runtime-wiring"
    commit id: "#97:runtime-wiring"
    merge C05 id: "C05 enables #99:command-registration"
    commit id: "#99:command-registration"
    checkout T09_install
    merge C02 id: "C02 enables #101:runtime-wiring"
    commit id: "#101:runtime-wiring"
    merge C05 id: "C05 enables #101:service-adapters"
    commit id: "#101:service-adapters"
    checkout T10_containers
    merge C05 id: "C05 enables #104:command-registration"
    commit id: "#104:command-registration"
    checkout T11_clients
    merge C05 id: "C05 enables #107:command-registration"
    commit id: "#107:command-registration"
    merge C06 id: "C06 enables #109:client-contract"
    commit id: "#109:client-contract"
    checkout T12_lifecycle
    merge C05 id: "C05 enables #110:command-registration"
    commit id: "#110:command-registration"
    checkout T02_materialization
    commit id: "#49:materialized-core"
    checkout T06_d2k
    merge C06 id: "C06 enables #92"
    commit id: "#92" tag: "planned"
    checkout T07_metrics
    commit id: "#94" tag: "planned"
    checkout T08_config
    commit id: "#97" tag: "planned"
    checkout T11_clients
    commit id: "#107" tag: "planned"
    checkout T02_materialization
    commit id: "#49" tag: "planned"
    checkout T08_config
    commit id: "#98" tag: "planned"

    %% C03: Protected live API
    %% requires (AND): C02, issue:49:materialized-core, issue:44:protected-api
    %% unlocks: issue:89:live-preservation, issue:95:live-health-probes
    checkout main
    branch C03
    commit id: "C03 collect"
    %% input: C02
    merge C02 id: "C03 input 1"
    %% input: issue:49:materialized-core
    merge T02_materialization id: "C03 input 2"
    %% input: issue:44:protected-api
    merge T03_node id: "C03 input 3"
    commit id: "C03" tag: "Protected live API" type: HIGHLIGHT

    %% C08: Published client endpoints
    %% requires (AND): issue:104:instance-contract, issue:105:published-endpoints, issue:107
    %% unlocks: issue:108
    checkout main
    branch C08
    commit id: "C08 collect"
    %% input: issue:104:instance-contract, issue:105:published-endpoints
    merge T10_containers id: "C08 input 1"
    %% input: issue:107
    merge T11_clients id: "C08 input 2"
    commit id: "C08" tag: "Published client endpoints" type: HIGHLIGHT
    checkout T03_node
    merge C03 id: "C03 enables #44:live-node"
    commit id: "#44:live-node"
    checkout T05_portainer
    merge C03 id: "C03 enables #89:live-preservation"
    commit id: "#89:live-preservation"
    checkout T07_metrics
    merge C03 id: "C03 enables #95:live-health-probes"
    commit id: "#95:live-health-probes"
    checkout T02_materialization
    commit id: "#50" tag: "planned"
    checkout T11_clients
    merge C08 id: "C08 enables #108"
    commit id: "#108" tag: "planned"

    %% C07: Safe configuration edits
    %% requires (AND): issue:97, issue:98
    %% unlocks: issue:99, issue:110:api-integration
    checkout main
    branch C07
    commit id: "C07 collect"
    %% input: issue:97, issue:98
    merge T08_config id: "C07 input 1"
    commit id: "C07" tag: "Safe configuration edits" type: HIGHLIGHT
    checkout T12_lifecycle
    merge C07 id: "C07 enables #110:api-integration"
    commit id: "#110:api-integration"
    checkout T02_materialization
    commit id: "#6" tag: "planned"
    checkout T03_node
    commit id: "#44" tag: "planned"
    checkout T05_portainer
    commit id: "#89" tag: "planned"
    checkout T07_metrics
    commit id: "#95" tag: "planned"
    checkout T08_config
    merge C07 id: "C07 enables #99"
    commit id: "#99" tag: "planned"

    %% C04: Running production node
    %% requires (AND): C03, issue:46:prepared-host, issue:50:runtime-selection, issue:44:live-node
    %% unlocks: issue:90:live-bootstrap, issue:93:live-workload, issue:96:live-diagnostics, issue:101:live-service, issue:102:live-install, issue:104:live-instances, issue:121:rust-measurements
    checkout main
    branch C04
    commit id: "C04 collect"
    %% input: C03
    merge C03 id: "C04 input 1"
    %% input: issue:46:prepared-host
    merge T04_host id: "C04 input 2"
    %% input: issue:50:runtime-selection
    merge T02_materialization id: "C04 input 3"
    %% input: issue:44:live-node
    merge T03_node id: "C04 input 4"
    commit id: "C04" tag: "Running production node" type: HIGHLIGHT

    %% C12: Package assembly inputs
    %% requires (AND): issue:114:node-builds, issue:48, issue:49, issue:50
    %% unlocks: issue:115:node-assembly
    checkout main
    branch C12
    commit id: "C12 collect"
    %% input: issue:114:node-builds, issue:48
    merge T01_payloads id: "C12 input 1"
    %% input: issue:49, issue:50
    merge T02_materialization id: "C12 input 2"
    commit id: "C12" tag: "Package assembly inputs" type: HIGHLIGHT
    checkout T05_portainer
    merge C04 id: "C04 enables #90:live-bootstrap"
    commit id: "#90:live-bootstrap"
    checkout T06_d2k
    merge C04 id: "C04 enables #93:live-workload"
    commit id: "#93:live-workload"
    checkout T07_metrics
    merge C04 id: "C04 enables #96:live-diagnostics"
    commit id: "#96:live-diagnostics"
    checkout T09_install
    merge C04 id: "C04 enables #101:live-service"
    commit id: "#101:live-service"
    commit id: "#102:live-install"
    checkout T10_containers
    merge C04 id: "C04 enables #104:live-instances"
    commit id: "#104:live-instances"
    checkout T13_packages
    merge C12 id: "C12 enables #115:node-assembly"
    commit id: "#115:node-assembly"
    checkout T17_performance
    merge C04 id: "C04 enables #121:rust-measurements"
    commit id: "#121:rust-measurements"
    checkout T03_node
    commit id: "#4" tag: "planned"
    checkout T04_host
    merge C04 id: "C04 enables #47"
    commit id: "#47" tag: "planned"
    checkout T08_config
    commit id: "#22" tag: "planned"
    checkout T12_lifecycle
    commit id: "#110" tag: "planned"
    checkout T02_materialization
    commit id: "T02 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T13_packages
    commit id: "#115:packages"
    checkout T04_host
    commit id: "#5" tag: "planned"
    checkout T05_portainer
    commit id: "#90" tag: "planned"
    checkout T06_d2k
    commit id: "#93" tag: "planned"
    checkout T07_metrics
    commit id: "#96" tag: "planned"
    checkout T09_install
    commit id: "#101" tag: "planned"

    %% C09: Both lifecycle backends
    %% requires (AND): issue:101:service-contract, issue:106:instance-lifecycle, issue:110
    %% unlocks: issue:111, issue:112
    checkout main
    branch C09
    commit id: "C09 collect"
    %% input: issue:101:service-contract
    merge T09_install id: "C09 input 1"
    %% input: issue:106:instance-lifecycle
    merge T10_containers id: "C09 input 2"
    %% input: issue:110
    merge T12_lifecycle id: "C09 input 3"
    commit id: "C09" tag: "Both lifecycle backends" type: HIGHLIGHT
    checkout T08_config
    commit id: "T08 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T13_packages
    commit id: "#116:candidate-inventory"
    checkout T05_portainer
    commit id: "#19" tag: "planned"
    checkout T06_d2k
    commit id: "#20" tag: "planned"
    checkout T07_metrics
    commit id: "#21" tag: "planned"
    checkout T09_install
    commit id: "#102" tag: "planned"
    checkout T12_lifecycle
    branch T12_upgrade
    commit id: "#111 parallel work"
    merge C09 id: "C09 enables #111"
    commit id: "#111" tag: "planned"
    checkout T12_lifecycle
    branch T12_reset
    commit id: "#112 parallel work"
    merge C09 id: "C09 enables #112"
    commit id: "#112" tag: "planned"

    %% C10: Authenticated Docker access
    %% requires (AND): C06, issue:93, issue:108
    %% unlocks: issue:109
    checkout main
    branch C10
    commit id: "C10 collect"
    %% input: C06
    merge C06 id: "C10 input 1"
    %% input: issue:93
    merge T06_d2k id: "C10 input 2"
    %% input: issue:108
    merge T11_clients id: "C10 input 3"
    commit id: "C10" tag: "Authenticated Docker access" type: HIGHLIGHT
    checkout T04_host
    commit id: "T04 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T11_clients
    merge C10 id: "C10 enables #109"
    commit id: "#109" tag: "planned"

    %% C11: Selective lifecycle cleanup
    %% requires (AND): issue:111, issue:112, issue:108
    %% unlocks: issue:113
    checkout main
    branch C11
    commit id: "C11 collect"
    %% input: issue:111
    merge T12_upgrade id: "C11 input 1"
    %% input: issue:112
    merge T12_reset id: "C11 input 2"
    %% input: issue:108
    merge T11_clients id: "C11 input 3"
    commit id: "C11" tag: "Selective lifecycle cleanup" type: HIGHLIGHT

    %% C12a: Candidate package outputs
    %% requires (AND): issue:115:packages, issue:116:candidate-inventory
    %% unlocks: issue:103:offline-install, issue:104:packaged-images, issue:114:install-smoke, issue:115:install-smoke
    checkout main
    branch C12a
    commit id: "C12a collect"
    %% input: issue:115:packages, issue:116:candidate-inventory
    merge T13_packages id: "C12a input 1"
    commit id: "C12a" tag: "Candidate package outputs" type: HIGHLIGHT
    checkout T05_portainer
    commit id: "T05 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T06_d2k
    commit id: "T06 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T07_metrics
    commit id: "T07 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T01_payloads
    merge C12a id: "C12a enables #114:install-smoke"
    commit id: "#114:install-smoke"
    checkout T09_install
    merge C12a id: "C12a enables #103:offline-install"
    commit id: "#103:offline-install"
    checkout T10_containers
    merge C12a id: "C12a enables #104:packaged-images"
    commit id: "#104:packaged-images"
    checkout T13_packages
    merge C12a id: "C12a enables #115:install-smoke"
    commit id: "#115:install-smoke"
    checkout T11_clients
    commit id: "#25" tag: "planned"
    checkout T12_lifecycle
    merge C11 id: "C11 enables #113"
    merge T12_upgrade id: "#111 joins lifecycle"
    merge T12_reset id: "#112 joins lifecycle"
    commit id: "#113" tag: "planned"
    checkout T01_payloads
    commit id: "#114" tag: "planned"
    checkout T09_install
    commit id: "#103" tag: "planned"
    checkout T10_containers
    commit id: "#104" tag: "planned"
    checkout T12_lifecycle
    commit id: "#26" tag: "planned"
    checkout T13_packages
    commit id: "#115" tag: "planned"
    checkout T11_clients
    commit id: "T11 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T09_install
    commit id: "#23" tag: "planned"
    checkout T10_containers
    commit id: "#105" tag: "planned"
    checkout T13_packages
    commit id: "#116" tag: "planned"
    checkout T01_payloads
    commit id: "T01 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T12_lifecycle
    commit id: "T12 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T10_containers
    commit id: "#106" tag: "planned"
    checkout T13_packages
    commit id: "#117" tag: "planned"
    checkout T09_install
    commit id: "T09 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T10_containers
    commit id: "#24" tag: "planned"
    checkout T13_packages
    commit id: "#27" tag: "planned"

    %% C13: Final candidate child outputs
    %% requires (AND): C04, issue:44, issue:46, issue:47, issue:48, issue:49, issue:50, issue:90, issue:93, issue:96, issue:99, issue:103, issue:106, issue:109, issue:113, issue:114, issue:115, issue:116, issue:117
    %% unlocks: issue:2:consumer-integration, issue:3:consumer-integration, issue:118:final-candidate-runs, issue:119:final-candidate-runs, issue:121:final-candidate-runs, issue:124:transition-runs
    checkout main
    branch C13
    commit id: "C13 collect"
    %% input: C04
    merge C04 id: "C13 input 1"
    %% input: issue:44
    merge T03_node id: "C13 input 2"
    %% input: issue:46, issue:47
    merge T04_host id: "C13 input 3"
    %% input: issue:48, issue:114
    merge T01_payloads id: "C13 input 4"
    %% input: issue:49, issue:50
    merge T02_materialization id: "C13 input 5"
    %% input: issue:90
    merge T05_portainer id: "C13 input 6"
    %% input: issue:93
    merge T06_d2k id: "C13 input 7"
    %% input: issue:96
    merge T07_metrics id: "C13 input 8"
    %% input: issue:99
    merge T08_config id: "C13 input 9"
    %% input: issue:103
    merge T09_install id: "C13 input 10"
    %% input: issue:106
    merge T10_containers id: "C13 input 11"
    %% input: issue:109
    merge T11_clients id: "C13 input 12"
    %% input: issue:113
    merge T12_lifecycle id: "C13 input 13"
    %% input: issue:115, issue:116, issue:117
    merge T13_packages id: "C13 input 14"
    commit id: "C13" tag: "Final candidate child outputs" type: HIGHLIGHT
    checkout T03_node
    merge C13 id: "C13 enables #2:consumer-integration"
    commit id: "#2:consumer-integration"
    commit id: "#3:consumer-integration"
    checkout T14_workloads
    merge C13 id: "C13 enables #118:final-candidate-runs"
    commit id: "#118:final-candidate-runs"
    checkout T15_recovery
    merge C13 id: "C13 enables #119:final-candidate-runs"
    commit id: "#119:final-candidate-runs"
    checkout T17_performance
    merge C13 id: "C13 enables #121:final-candidate-runs"
    commit id: "#121:final-candidate-runs"
    checkout T18_transition
    merge C13 id: "C13 enables #124:transition-runs"
    commit id: "#124:transition-runs"
    checkout T10_containers
    commit id: "T10 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T13_packages
    commit id: "T13 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T03_node
    commit id: "#2" tag: "planned"
    commit id: "#3" tag: "planned"
    checkout T14_workloads
    commit id: "#118" tag: "planned"
    checkout T15_recovery
    commit id: "#119" tag: "planned"
    checkout T17_performance
    commit id: "#121" tag: "planned"
    checkout T18_transition
    commit id: "#124" tag: "planned"
    checkout T17_performance
    commit id: "#122" tag: "planned"

    %% C14: Workload and recovery qualification
    %% requires (AND): issue:118, issue:119
    %% unlocks: T16
    checkout main
    branch C14
    commit id: "C14 collect"
    %% input: issue:118
    merge T14_workloads id: "C14 input 1"
    %% input: issue:119
    merge T15_recovery id: "C14 input 2"
    commit id: "C14" tag: "Workload and recovery qualification" type: HIGHLIGHT
    checkout T03_node
    commit id: "T03 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T14_workloads
    commit id: "T14 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T15_recovery
    commit id: "T15 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout main
    branch T16_platforms
    commit id: "T16 bounded work" tag: "blocked at snapshot"
    merge C14 id: "C14 opens T16"
    checkout T17_performance
    commit id: "#123" tag: "planned"
    checkout T16_platforms
    commit id: "#120" tag: "planned"
    commit id: "#28" tag: "planned"
    commit id: "T16 acceptance" tag: "planned ledger" type: HIGHLIGHT

    %% C15: Platform and epic acceptance
    %% requires (AND): T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T16
    %% unlocks: issue:29:final-acceptance, issue:125:final-recovery-rehearsal
    checkout main
    branch C15
    commit id: "C15 collect"
    %% input: T02
    merge T02_materialization id: "C15 input 1"
    %% input: T03
    merge T03_node id: "C15 input 2"
    %% input: T04
    merge T04_host id: "C15 input 3"
    %% input: T05
    merge T05_portainer id: "C15 input 4"
    %% input: T06
    merge T06_d2k id: "C15 input 5"
    %% input: T07
    merge T07_metrics id: "C15 input 6"
    %% input: T08
    merge T08_config id: "C15 input 7"
    %% input: T09
    merge T09_install id: "C15 input 8"
    %% input: T10
    merge T10_containers id: "C15 input 9"
    %% input: T11
    merge T11_clients id: "C15 input 10"
    %% input: T12
    merge T12_lifecycle id: "C15 input 11"
    %% input: T13
    merge T13_packages id: "C15 input 12"
    %% input: T16
    merge T16_platforms id: "C15 input 13"
    commit id: "C15" tag: "Platform and epic acceptance" type: HIGHLIGHT
    checkout T17_performance
    merge C15 id: "C15 enables #29:final-acceptance"
    commit id: "#29:final-acceptance"
    checkout T18_transition
    merge C15 id: "C15 enables #125:final-recovery-rehearsal"
    commit id: "#125:final-recovery-rehearsal"
    checkout T17_performance
    commit id: "#29" tag: "planned"
    checkout T18_transition
    commit id: "#125" tag: "planned"
    checkout T17_performance
    commit id: "T17 acceptance" tag: "planned ledger" type: HIGHLIGHT
    checkout T18_transition
    commit id: "T18 acceptance" tag: "planned ledger" type: HIGHLIGHT

    %% C16: Exact qualified candidate
    %% requires (AND): C13, C15, T14, T15, T17, T18
    %% unlocks: T19
    checkout main
    branch C16
    commit id: "C16 collect"
    %% input: C13
    merge C13 id: "C16 input 1"
    %% input: C15
    merge C15 id: "C16 input 2"
    %% input: T14
    merge T14_workloads id: "C16 input 3"
    %% input: T15
    merge T15_recovery id: "C16 input 4"
    %% input: T17
    merge T17_performance id: "C16 input 5"
    %% input: T18
    merge T18_transition id: "C16 input 6"
    commit id: "C16" tag: "Exact qualified candidate" type: HIGHLIGHT
    checkout main
    branch T19_release
    commit id: "T19 bounded work" tag: "blocked at snapshot"
    merge C16 id: "C16 opens T19"
    commit id: "#126" tag: "planned"
    commit id: "#30" tag: "planned"
    commit id: "T19 acceptance" tag: "planned ledger" type: HIGHLIGHT

    %% C17: All tracks accepted
    %% requires (AND): T00, T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19
    %% unlocks: completion
    checkout main
    branch C17
    commit id: "C17 collect"
    %% input: T00
    %% input: T01
    merge T01_payloads id: "C17 input 2"
    %% input: T02
    merge T02_materialization id: "C17 input 3"
    %% input: T03
    merge T03_node id: "C17 input 4"
    %% input: T04
    merge T04_host id: "C17 input 5"
    %% input: T05
    merge T05_portainer id: "C17 input 6"
    %% input: T06
    merge T06_d2k id: "C17 input 7"
    %% input: T07
    merge T07_metrics id: "C17 input 8"
    %% input: T08
    merge T08_config id: "C17 input 9"
    %% input: T09
    merge T09_install id: "C17 input 10"
    %% input: T10
    merge T10_containers id: "C17 input 11"
    %% input: T11
    merge T11_clients id: "C17 input 12"
    %% input: T12
    merge T12_lifecycle id: "C17 input 13"
    %% input: T13
    merge T13_packages id: "C17 input 14"
    %% input: T14
    merge T14_workloads id: "C17 input 15"
    %% input: T15
    merge T15_recovery id: "C17 input 16"
    %% input: T16
    merge T16_platforms id: "C17 input 17"
    %% input: T17
    merge T17_performance id: "C17 input 18"
    %% input: T18
    merge T18_transition id: "C17 input 19"
    %% input: T19
    merge T19_release id: "C17 input 20"
    commit id: "C17" tag: "All tracks accepted" type: HIGHLIGHT
    checkout main
    merge C17 id: "completion planned"
    commit id: "Supported release complete" tag: "FUTURE acceptance" type: HIGHLIGHT

%% ORIGINAL CONTEXT, OWNERSHIP, SEQUENCES AND EVIDENCE NOTES:
%% Execution map for https://github.com/geoffsee/rubix-kube, inspected 2026-10-02.
%% GitHub main and local HEAD: 014b37cba8d64683a49d5cdbc85c5eb6c14764dd.
%% Snapshot: 61 open issues (18 epics, 43 children), 67 closed issues, no open PRs.
%% Sources: live issue bodies and acceptance comments on #36/#38/#44/#47/#48;
%% docs/architecture/{compatibility-contract,acceptance-matrix}.md;
%% experiments/component-boundary/ADR.md; crates/*; tools/parity; tools/integration;
%% tools/upstream; .github/workflows. Existing implementation was inspected, not run.
%% The requested YAML replaces the skill's default parallel-work-plan.md output.
%% 
%% Reference rules:
%% - Txx identifies a Track; requiring it means all its acceptance work is complete.
%% - Cxx identifies a convergence point; requires is AND, unlocks releases each item.
%% - issue:N identifies an accepted child deliverable or an epic acceptance ledger.
%% - issue:N:milestone identifies the narrower output described at its convergence
%% point; it never requires the whole issue/epic to close first.
%% - depends_on gates entry to a Track. ready means useful implementation, design or
%% fixture work can start; later live acceptance is gated separately below.
%% active records observed work; blocked awaits an identified entry deliverable.
%% - Issue lists are membership, not numeric execution order. Local sequences and
%% ownership are recorded beside each Track. Gates do not automatically close issues.
%% 
%% 17 Tracks have bounded work now: T01-T15 and T17-T18, including design/fixtures.
%% Immediate and potential concurrency are 17 lanes; contracts unlock production
%% work within those lanes. T16 subsequently joins two qualification lanes.
%% Recommend 8 workers initially; additional workers can own fixtures/metrics/access.
%% Available hardware, payload provenance and shared interfaces limit throughput.
%% Track count includes completed work and final evidence, not 20 concurrent workers.
%% 
%% Shared ownership: T03 owns node startup and production API/component seams; T04
%% owns host-specific preparation; T09 owns rubixctl parse/lib/main registration.
%% Other CLI Tracks add separate command modules behind T09's handler contract.
%% T01 owns production pins/build recipes, T02 materialization/selection, T13 package
%% layouts/release workflows. Serialize Cargo.toml/Cargo.lock, common tools/dev
%% registration and fixture provenance updates through the relevant owner.
%% T03 owns datastore PKI; T06 owns D2K credential policy. Coordinate shared PKI
%% edits and API-client changes with active T05. Shared files alone do not serialize
%% whole Tracks. Every implementation merge retains existing required CI checks.
%% Closed issue state and merged foundations only; production acceptance remains
%% open. E01 selected Rust supervision of official executables and Kine SQLite.
%% E02/E03 foundation children, PKI/component/addon libraries and #88 are merged.
%% Ownership: production asset lock/catalog and node build/acquisition tooling.
%% #48 is currently labelled blocked; investigation/build recipes can start now.
%% Pair #48 with #114 to resolve origins, hashes, sizes, ABI and license closure,
%% beginning with a complete Linux arm64/glibc payload cell, then the full matrix.
%% Existing Manifest/ELF/archive/layer checks are reusable, not production pins.
%% This pairing avoids making asset acquisition wait for complete E27 packaging.
%% Ownership: rubix-assets installation/selection and runtime import handoff.
%% #49 -> #50; #6 closes after the E02/E03 consumer integration ledger passes.
%% Existing inventory contracts permit implementation/negative fixtures now;
%% C01 gates production-byte acceptance. Read-only verification does not install
%% bytes. Deliver atomic owned
%% placement, permissions, corruption/partial-write rejection, enabled images and
%% host-supplied dependency builds; external CRI ownership is a separate choice.
%% Ownership: rubix-kube startup, retained-process adapters, real API client and
%% integrated config/lifecycle/parity receipts. #44 implementation first; #2/#3/#4
%% close on their integration evidence, not on the closed foundation children.
%% main.rs still rejects startup. Current API start() only sets running state;
%% datastore uses custom RUBXSNP1/RUBXWAL1 files, not Kine SQLite. Controller,
%% kubelet/proxy models and plaintext webhook transport also need reconciliation
%% with the accepted official-process/TLS boundary. Reuse valid config/ownership
%% code, establish actual adapters and independently re-test the live behavior.
%% Real DNS/provisioner/helper/pod tests must replace model-only parity claims.
%% C02 publishes interfaces early; C03/C04 release successive live consumers.
%% Ownership: rubix-platform and rubix-kube host preparation/constrained modules.
%% Reuse merged preparation; #46 integration -> #47 acceptance -> #5 ledger.
%% Real nftables-only kernel investigation can start independently now; retained
%% evidence explicitly reports nft_only_kernel_qualified: false. C04 is the
%% running-node gate, not a requirement to wait for the whole T03 to close.
%% Ownership: rubix-portainer create-only reconciler/service and its tests.
%% #89 -> #90 -> #19. Local branch feat/portainer-preserve-existing-objects has
%% uncommitted reconciler/service/tests/docs and rubix-apiserver/client.rs edits.
%% Preserve that ownership; it is active progress, not merged #89 completion.
%% C03 permits live preservation; C04 and image selection permit offline/default
%% and custom-image runs, with optional failures leaving the actual API healthy.
%% Ownership: D2K image characterization, resources, credentials and enablement.
%% #91 -> #92 -> #93 -> #20. Start digest-pinned TLS negative/positive probes now.
%% Current cluster PKI unconditionally creates fixture-d2k certificates; coordinate
%% disabled/unsupported no-credential behavior and namespace SANs with T03.
%% C06 provides the real server/client contract to both this Track and T11.
%% Ownership: new metrics endpoint/collectors/diagnostic modules, not a new
%% Kubernetes metrics-server. #94 -> #95 -> #96 -> #21. LifecycleObserver and PKI
%% observations already allow endpoint/fixture work. Final health probes consume
%% real runtime adapters; disabled/bind-failure behavior and overhead are measured.
%% Ownership: stored-config API, transaction/redaction policy, separate CLI module.
%% #97 -> #98 -> #99 -> #22. Existing E03 atomic 0600 writer has no transaction
%% lock/CAS; implement whole read-modify-write serialization and ETag/If-Match.
%% Use stored-file semantics, RFC7386 null defaults and shared backups. C05 gates
%% common CLI registration; C07 supplies safe API/direct-file editing to T12.
%% Ownership: rubixctl shell/dispatch, downloads, host services/install/bundles.
%% #100 -> #101 -> #102 -> #103 -> #23. Only check/version/help exist today.
%% Publish command-handler and artifact-version contracts before completing this
%% Track, so other management Tracks need not wait for a complete installer.
%% Service definitions can use fixture adapters now; real reboot/API acceptance
%% waits for C04. Offline installation consumes C12a package outputs, not E27 closure.
%% Ownership: Docker-compatible Engine backend, instance inventory, ports/volumes.
%% #104 -> #105 -> #106 -> #24. Engine request/ownership/port fixtures start now;
%% C05 integrates commands, C04/C12a supply runnable images. Publish actual random
%% loopback endpoints at C08 and lifecycle primitives at C09 before epic closure.
%% Test two named instances, persistence, recreation, MTU and selective cleanup.
%% Ownership: kubeconfig merge/identity/backup and selected Docker client contexts.
%% #107 -> #108 -> #109 -> #25. Internal PKI kubeconfigs are not client merge logic.
%% Merge/identity fixtures start now; C08 supplies published endpoints and C10
%% supplies authenticated D2K access. Preserve unrelated contexts/users/credentials.
%% Ownership: legacy migration and user-facing upgrade/reset/uninstall policy.
%% #110 -> (#111 and #112) -> #113 -> #26. Begin version gates, legacy argument
%% conversion and retention/interruption fixtures with the existing E03 writer.
%% C07 integrates serialized edits, C09 supplies both backend lifecycles, C11
%% joins upgrade/reset with selective client cleanup. Keep destructive policy
%% here and reuse T09/T10 primitives; preserve external runtime/neighbor ownership.
%% Ownership: package layouts, management/archive/OCI builds, provenance/licenses
%% and trusted release workflows. #115 -> #116 -> #117 -> #27; package-layout,
%% provenance and workflow fixtures start now. C12 gates actual node assembly.
%% Provide candidate packages before installer/container epic closure. #117 is
%% publication machinery and update rehearsal; supported publication is T19's
%% final gate. Changed candidate bytes must be rebuilt and requalified.
%% Ownership: six manifest-domain suites and selected single-node conformance.
%% Fixtures/selection can start now. C13 releases final digest-bound execution;
%% this Track runs independently of T15 against equivalent isolated candidates.
%% Ownership: historical regression mapping, crash/reboot/ownership/fault suites.
%% Fixtures start now; C13 releases live candidate execution. Coordinate shared
%% harness/report schema with T14, while each owns separate suites/test resources.
%% Ownership: final platform/runtime/variant coverage report and sustained soak.
%% #120 joins #118/#119; #28 additionally closes all prerequisite epic ledgers.
%% Existing arm64 defaults/API-Kine integration CI does not qualify a full node
%% or other architectures. Do not silently replace unavailable hardware with passes.
%% Ownership: matched environments, trusted measurements/thresholds and profiles.
%% #121 -> #122 -> #123 -> #29. Measurement design and Go reference runs start now;
%% C13 supplies complete Rust candidates. Include retained processes/helpers/images.
%% Final E29 acceptance also requires C15 compatibility/platform evidence. Fixes
%% changing bytes create a new candidate and invalidate applicable old receipts;
%% this is a repeated validation rule, not a cyclic dependency in this snapshot.
%% Ownership: supported Go starting versions and cross-distribution state/recovery
%% fixtures. #124 -> #125. Design/inventory starts now; C13 supplies runnable
%% lifecycle-capable candidates. Validate actual Kine/SQLite reuse or export/import,
%% not interchangeability with the current custom datastore format. Final rehearsals
%% use the same qualified bytes as platform/performance reports at C16.
%% Ownership: consolidated operator rehearsal, release notes/docs and final release.
%% #126 -> #30. Feature owners document behavior throughout; this Track verifies
%% the fresh-operator handoff and ships the exact qualified artifacts after C16.
%% A complete accepted arm64/glibc payload cell: immutable binary/image identities,
%% sizes, encoding, ABI, source/build/license records and supported image closure;
%% #114 supplies the acquisition/build recipe. A synthetic manifest is insufficient.
%% #44 publishes retained process options, authenticated API client interfaces,
%% dedicated datastore credential paths, dependency/readiness/failure semantics.
%% Consumers can wire against this contract before the entire node is operational.
%% Protected Kine SQLite and official API processes perform authenticated CRUD,
%% negative datastore mTLS probes and bounded shutdown using materialized core bytes.
%% Actual core startup/workloads, CNI/egress ordering, TLS admission, controllers,
%% routing/DNS/storage and optional-failure policy; no local model substitutes.
%% T09 publishes typed handler inputs, selected instance/run mode/config path,
%% completion/error conventions and one artifact version/target-selection contract.
%% Other Tracks already have independent library/fixture work before this join.
%% Digest-pinned D2K valid/missing/wrong-client-certificate probes and an explicit
%% TLS/authentication decision; do not assume server TLS establishes mTLS.
%% Shared validation, serialized desired-document mutation, ETag/If-Match, secret
%% retention/redaction and atomic backup behavior, consumed without a second writer.
%% Selected named-instance ownership and actual Engine endpoint lookup plus safe
%% kubeconfig merge/identity are enough; full E24 completion is unnecessary here.
%% Host and container start/stop/status/replace/remove ownership contracts and safe
%% legacy migration. Upgrade and reset can proceed concurrently in separate modules.
%% Target-correct node builds, full production pins and materialization/selection
%% unlock packaging. Do not require full host/container or E06/E27 epic closure.
%% Package output is a partial T13 delivery: installers and Engine clients consume
%% it before T13's final smoke/provenance/publication-workflow acceptance completes.
%% Final candidate join uses CHILD outputs, not epic closure; parent dependencies
%% are integration ledgers. This avoids installer <-> package and E02 <-> consumer
%% cycles. Preliminary component/fixture runs can happen earlier at C03/C04.
%% All component/operator/foundation acceptance ledgers and the platform/soak
%% report converge. Performance and migration fixtures started before this point;
%% their final acceptance must bind the qualified candidate and these ledgers.
%% Exact candidate, compatibility, ownership, performance, successful transition
%% and failed-transition recovery evidence all converge before operator handoff.
%% Explicit final join: every Track, including the previously merged baseline,
%% contributes to project completion. Publishing is future work, not this analysis.

%% COMPLETION CRITERIA (all required):
%% 1. All E01-E30 acceptance ledgers and every required child deliverable are satisfied with independently sourced, current evidence. Closed issue state, compilation, fixture-only success and historical captures are insufficient.
%% 2. Production startup supervises the accepted official Kubernetes and Kine SQLite boundary with dedicated datastore mTLS, real API/authentication/TLS admission, managed/external runtime behavior, networking, routing, DNS and pod-mounted persistent storage. Required defaults and compatibility survive reconciliation of the current native models with the accepted architecture.
%% 3. Sixteen Linux node archive cells (amd64, arm64, ARMv7 and riscv64, each glibc and musl, each online and offline), four OCI architectures and four Linux/macOS amd64/arm64 management artifacts have matching build/layout/install evidence. Required external-dependency builds work; unavailable hardware or payloads remain gaps unless an explicit accepted scope decision changes the contract.
%% 4. Online CoreDNS/pause and enabled offline images, including the local-path helper, work with egress denied where promised. Portainer/D2K target limits, custom-image acquisition, disabled side effects and actual D2K authentication match the accepted contract and have positive/negative live evidence.
%% 5. Host and named-container install/reboot/recreate/client access work; config API/direct-file edits preserve private modes, backups, secrets and concurrency. Upgrade/reset/uninstall interruption and retention matrices preserve external runtimes, unrelated processes, neighboring installations and selected data.
%% 6. Fresh candidate-bound smoke, six manifest-domain suites, selected conformance, historical regressions, valid platform/runtime/variant coverage and soak pass. Counts, exclusions and unsupported combinations are explicit; no required failure or unexplained skip is hidden and no full certification is inferred.
%% 7. Matched amd64/arm64 whole-distribution reports include all retained processes and assets. Startup, idle memory and size meet the provisional 1.10x reference gates; density meets 0.90x; final settled 24-hour memory stays within 1.10x initial without OOM/crash/unexplained probe failure. Shutdown honors 30-second graceful and 35-second cleanup bounds. Regressions require measured correction or an explicit reviewed scope/budget decision, with trusted CI regression gates.
%% 8. Supported Go-to-Rust starting versions have tested state reuse or explicit export/import preserving promised database, PKI/client identity, workloads, PV data, registry and configuration. Interrupted transitions recover from available retained backups; downtime and nonportable state are documented.
%% 9. Format, Clippy, debug/release Tests, Dependencies, Security, generation/fixture drift and relevant disposable integration checks pass for final source and artifacts. Preserve edition 2024, Rust 1.97, unsafe_code deny and the existing strict Clippy/await_holding_lock policies.
%% 10. Artifact hashes bind build/source/generator/image/license inventories and all qualification reports. Any optimization, upstream update or rebuild changing bytes produces a new candidate and reruns affected compatibility, performance, migration and operator checks; old passing receipts cannot qualify new bytes.
%% 11. A fresh operator completes install and migration/recovery from final docs. Release notes, limitations, retained-component attribution and verified checksums accompany the exact tested artifacts. Project-owned destinations and version policy are established and the supported release is published through the trusted pipeline before project completion is declared.
```

[rubix-kube-execution-swimlanes.md](https://github.com/user-attachments/files/32971825/rubix-kube-execution-swimlanes.md)