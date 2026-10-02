# Estimating Work in the Agent Era 

Three distinct estimation logics are in play. The first sizes agent work in its native unit (tokens). The second keeps the existing story-point scale and changes who produces and debates the estimate. The third decomposes agentic cost into token, oversight, and infrastructure streams and maps legacy sizing metrics onto those streams. Each is formalized below from the source logic, not as executable code.

## 1. Token-threshold sprint sizing

Smith Horn’s practitioner model replaces hour- or point-based item sizes with fixed token bins, on the claim that agents consume tokens rather than human time, so the planning unit should be the consumption unit.

Size map:

$$
\tau(s)=\begin{cases}
5\times 10^{4} & s=\mathrm{XS}\\
1\times 10^{5} & s=\mathrm{S}\\
2\times 10^{5} & s=\mathrm{M}\\
4\times 10^{5} & s=\mathrm{L}\\
\gt 4\times 10^{5} & s=\mathrm{XL}
\end{cases}
$$

Decomposition rule: any task with $\tau(s_i)>4\times 10^{5}$ is partitioned until every child satisfies $\tau(s_j)\le 4\times 10^{5}$.

Raw sprint load and parallel effective load, given dependency graph $G$:

$$
E_{\mathrm{raw}}=\sum_{i=1}^{n}\tau(s_i),\qquad E_{\mathrm{eff}}=\max_{p\in\mathrm{paths}(G)}\sum_{i\in p}\tau(s_i)
$$

Capacity is the token budget $B$: commit only if $E_{\mathrm{raw}}\le B$, or, under a swarm schedule, if $E_{\mathrm{eff}}\le B$. Illustrative cost is $C\approx E_{\mathrm{raw}}\cdot p$, with $p$ the price per token. Retrospective calibration replaces the bins with observed consumption: $\tau\leftarrow T_{\mathrm{actual}}$.

This is a discrete capacity heuristic. It forecasts model usage and API cost directly, and it does not encode review, integration, or human oversight except insofar as those activities themselves consume tokens. Bins are stated thresholds, not fitted functions.

Source: https://smithhorngroup.substack.com/p/beyond-story-points-token-based-sprint

## 2. Deliberative multi-agent story-point estimation

SEEAgent (Bui, Dam, Hoda) keeps effort in the project’s existing story-point scale and treats estimation as Planning Poker between agents and developers. Given history $\mathcal{D}=\{(Q_i,E_i)\}_{i=1}^{n}$, the target for a new story $Q'$ is $\hat{E}\approx E'$.

Each agent $\mathcal{A}_i$ has long-term memory $\mathcal{M}_l$ (supervised fine-tune on $\mathcal{D}$, or in-context stories for a cold project) and short-term memory $\mathcal{M}_s$. At round $t$:

$$
\hat{E}_i^{(t)}=\mathcal{M}_l\big(\cdot\mid Q',\,\mathcal{M}_s,\,\{\hat{E}_j^{(t-1)}\}_{j\neq i},\,H^{(t-1)}\big)
$$

$H^{(t-1)}$ is the dialogue of justifications and clarification questions. Stop when estimates agree within tolerance,

$$
\max_{i,k}\big|\hat{E}_i^{(t)}-\hat{E}_k^{(t)}\big|\le\epsilon,
$$

or when $t=r$. The published estimate $\hat{E}^*$ is the negotiated value, not a mean or median of the round.

Accuracy against ground truth is scored separately:

$$
\mathrm{MAE}=\frac{1}{n}\sum|y_i-\hat{y}_i|,\quad
\mathrm{MMRE}=\frac{1}{n}\sum\frac{|y_i-\hat{y}_i|}{y_i},\quad
\mathrm{PRED}(0.5)=\frac{1}{n}\sum\mathbf{1}\!\left[\frac{|y_i-\hat{y}_i|}{y_i}\le 0.5\right]
$$

The generative map $\mathcal{M}_l$ is not closed-form. The formula captures the protocol: condition on the story, peer estimates, and discussion history, then converge. Calibration is to the project’s historical points, so the unit of estimate does not change when the estimator does.

Source: https://arxiv.org/html/2509.14483v1

## 3. ACEM: additive agentic cost

El-Ramly’s ACEM treats agentic development cost as three additive streams. Constants stay symbolic pending calibration; the structure is fully specified.

$$
\mathrm{Total\_Cost}=C_{\mathrm{LLM}}+C_{\mathrm{HITL}}+C_{\mathrm{Infra}}
$$

LLM cost, with distinct input and output prices and model tiers $j$:

$$
C_{\mathrm{LLM}}=\sum_j\sum_{i\in S_j}\big(T_{\mathrm{in},i}\,P_{\mathrm{in},j}+T_{\mathrm{out},i}\,P_{\mathrm{out},j}\big)\,RF_i\,CF_i
$$

Base tokens come from artifact type and complexity, $T_{\mathrm{in},i}+T_{\mathrm{out},i}=\mathrm{BaseTokens}(\mathrm{type}_i,\mathrm{complexity}_i)$. The two agentic corrections are

$$
RF_i=1+(r_i\cdot n_i),\qquad CF_i=1+\alpha\cdot\frac{i}{N}
$$

$r_i$ is the rejection rate, $n_i$ the mean extra invocations per rejection, $i/N$ the task’s position in a pipeline of length $N$, and $\alpha$ the maximum proportional context growth. $RF=1$ and $CF=1$ are the no-revision, no-accumulation baselines. Context resets set $CF=1$ on the following segment. $CF$ is applied to a position-independent base, not to already context-inclusive logs.

Human oversight:

$$
C_{\mathrm{HITL}}=\sum_i(K_i\,D_i\,W)+\sum_i(r_i\,RW_i\,W)
$$

$K_i$ (checkpoint count) is set by the HITL Intensity Score: HIS-1 milestone only, HIS-2 story or use-case review, HIS-3 task-level review, HIS-4 continuous approval. $D_i$ and $RW_i$ are review and rework hours; $W$ is the loaded hourly rate. The same $r_i$ drives token retries in $C_{\mathrm{LLM}}$ and human rework in $C_{\mathrm{HITL}}$; the paper treats these as separate resource streams, not double-counting.

Infrastructure, outside the LLM bill:

$$
C_{\mathrm{Infra}}=\sum_k U_k\,P_k
$$

Legacy size maps onto base tokens, then into $C_{\mathrm{LLM}}$ via average $RF$ and $CF$:

$$
T_{\mathrm{base}}=U_{\mathrm{UCP}}\cdot\gamma_{\mathrm{UCP}},\qquad
T_{\mathrm{base}}=\sum_s SP_s\cdot\gamma_{\mathrm{SP}}\cdot CW_s,\qquad
T_{\mathrm{base}}=FP\cdot\gamma_{\mathrm{FP}}
$$

$CW_s<1$, $=1$, $>1$ for simple, medium, and complex stories. Unadjusted UCP and FP are preferred, because technical-complexity and value-adjustment factors are absorbed into BaseTokens and HIS.

Source: https://arxiv.org/abs/2608.02582

## What each formula actually prices

Token-bin sizing prices computational capacity and leaves review, testing, and oversight outside the equation unless they are themselves token tasks. SEEAgent prices nothing new: it estimates the same story points, with the estimator now a conditioned multi-agent dialogue anchored on $\mathcal{D}$. ACEM is the only one of the three that writes human oversight and orchestration into the total, and it does so with symbolic $\gamma$, $\alpha$, $r$, and $n$ that the paper explicitly leaves uncalibrated.