import json, sys
import pandas as pd, numpy as np
from scipy import stats
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

A = pd.DataFrame([json.loads(l) for l in open("data/final_A.jsonl")])
A["excess"] = A["booked"] - A["rooms_used"]          # guests confirmed without a physical room
A["ideal"] = np.minimum(A["N"], A["R"])
A["lost_pct"] = 100 * A["lost_sales"] / A["ideal"]
A["err_pct"] = 100 * A["error"] / A["N"]
A["any_oversell"] = A["excess"] > 0
A["timeouts"] = A["err_codes"].apply(lambda d: d.get("57014", 0) if isinstance(d, dict) else 0)
A["deadlocks"] = A["err_codes"].apply(lambda d: d.get("40P01", 0) if isinstance(d, dict) else 0)
order = ["S0_naive", "S1_constraint", "S2_arun", "S3_serializable", "S4_rowlock", "S5_hybrid"]
out = {"reps": int(A["rep"].max()), "runs": len(A)}

# Table 2: by strategy (all N, R)
t2 = A.groupby("strategy").agg(runs=("rep", "size"), oversell_runs=("any_oversell", "sum"), excess_mean=("excess", "mean"), excess_max=("excess", "max"),
                               lost_mean=("lost_pct", "mean"), err_mean=("err_pct", "mean"), p95_median=("p95", "median"),
                               timeouts=("timeouts", "sum"), deadlocks=("deadlocks", "sum")).reindex(order)
out["t2"] = t2.reset_index().to_dict("records")

# Table 3: lost sales % by strategy x R x N
t3 = A.pivot_table(index=["strategy"], columns=["R", "N"], values="lost_pct", aggfunc="mean").reindex(order)
out["t3"] = {s: {f"{r}_{n}": round(v, 1) for (r, n), v in row.items()} for s, row in t3.iterrows()}
t3e = A.pivot_table(index=["strategy"], columns=["R", "N"], values="excess", aggfunc="mean").reindex(order)
out["t3_excess"] = {s: {f"{r}_{n}": round(v, 2) for (r, n), v in row.items()} for s, row in t3e.iterrows()}
t3p = A.pivot_table(index=["strategy"], columns=["N"], values="p95", aggfunc="median").reindex(order)
out["t3_p95"] = {s: {str(n): round(v, 1) for n, v in row.items()} for s, row in t3p.iterrows()}
t3err = A.pivot_table(index=["strategy"], columns=["R", "N"], values="err_pct", aggfunc="mean").reindex(order)
out["t3_err"] = {s: {f"{r}_{n}": round(v, 1) for (r, n), v in row.items()} for s, row in t3err.iterrows()}

# Stats: safe strategies only (S1..S5) — Kruskal-Wallis on lost_pct and on p95 at each N
safe = [s for s in order if s != "S0_naive"]
ks = {}
for N in sorted(A["N"].unique()):
    sub = A[A["N"] == N]
    for metric in ["lost_pct", "p95"]:
        groups = [sub[sub["strategy"] == s][metric].values for s in safe]
        H, p = stats.kruskal(*groups)
        n = sum(len(g) for g in groups); k = len(groups)
        eps2 = (H - k + 1) / (n - k)
        ks[f"{metric}_N{N}"] = {"H": round(H, 2), "df": k - 1, "p": float(p), "eps2": round(eps2, 3)}
out["kruskal"] = ks
# Pairwise S2 vs S5 (Mann-Whitney) on lost_pct and p95 overall, and Fisher S4 vs S5 on oversell runs
mw = {}
for metric in ["lost_pct", "p95"]:
    a, b = A[A.strategy == "S2_arun"][metric], A[A.strategy == "S5_hybrid"][metric]
    U, p = stats.mannwhitneyu(a, b, alternative="two-sided")
    r = 1 - 2 * U / (len(a) * len(b))
    mw[metric] = {"U": float(U), "p": float(p), "rank_biserial": round(r, 3), "median_S2": float(np.median(a)), "median_S5": float(np.median(b))}
out["mw_S2_S5"] = mw
c4 = A[A.strategy == "S4_rowlock"]["any_oversell"]; c5 = A[A.strategy == "S5_hybrid"]["any_oversell"]
odds, pf = stats.fisher_exact([[c4.sum(), len(c4) - c4.sum()], [c5.sum(), len(c5) - c5.sum()]])
out["fisher_S4_S5"] = {"S4_oversell_runs": int(c4.sum()), "S4_runs": len(c4), "S5_oversell_runs": int(c5.sum()), "S5_runs": len(c5), "p": float(pf)}

# Experiment B
try:
    B = pd.DataFrame([json.loads(l) for l in open("data/final_B.jsonl")])
    tb = B.groupby(["mode", "D"]).agg(runs=("rep", "size"), dup_mean=("duplicates", "mean"), dup_min=("duplicates", "min"), dup_max=("duplicates", "max"),
                                      missing=("missing", "sum"), p95=("p95", "median")).reset_index()
    out["tB"] = tb.to_dict("records")
except FileNotFoundError:
    out["tB"] = None

json.dump(out, open("data/stats.json", "w"), ensure_ascii=False, indent=1, default=float)

# Figure 2: lost sales vs N, panels by R
lab = {"S0_naive": "S0 naive", "S1_constraint": "S1 constraint only (ARUN direct)", "S2_arun": "S2 ARUN OTA path", "S3_serializable": "S3 serializable",
       "S4_rowlock": "S4 row lock", "S5_hybrid": "S5 hybrid (proposed)"}
GRAY = {"S0_naive": "#000000", "S1_constraint": "#000000", "S2_arun": "#444444", "S3_serializable": "#777777", "S4_rowlock": "#999999", "S5_hybrid": "#000000"}
LS = {"S0_naive": ":", "S1_constraint": "-", "S2_arun": "--", "S3_serializable": "-.", "S4_rowlock": ":", "S5_hybrid": "-"}
mk = {"S0_naive": "x", "S1_constraint": "s", "S2_arun": "o", "S3_serializable": "^", "S4_rowlock": "v", "S5_hybrid": "D"}
fig, axes = plt.subplots(1, 3, figsize=(10, 3.3), dpi=200, sharey=True)
for ax, R in zip(axes, [1, 5, 20]):
    for s in safe:
        d = A[(A.strategy == s) & (A.R == R)].groupby("N")["lost_pct"].mean()
        ax.plot(range(len(d)), d.values, marker=mk[s], lw=1.1, ms=4, label=lab[s], color=GRAY[s], ls=LS[s])
    ax.set_xticks(range(4)); ax.set_xticklabels([10, 50, 200, 1000]); ax.set_title(f"R = {R}", fontsize=9)
    ax.set_xlabel("Concurrent requests (N)", fontsize=8); ax.grid(alpha=.3); ax.tick_params(labelsize=7)
axes[0].set_ylabel("Lost sales (% of sellable rooms)", fontsize=8)
h, l = axes[2].get_legend_handles_labels(); fig.legend(h, l, loc="lower center", ncol=3, fontsize=7, frameon=False, bbox_to_anchor=(0.5, -0.1))
plt.tight_layout(); plt.savefig("figures/fig_lost_sales.png", bbox_inches="tight")

# Figure 3: p95 latency by N (median of runs), log scale
fig, ax = plt.subplots(figsize=(6, 3.2), dpi=200)
for s in order:
    d = A[A.strategy == s].groupby("N")["p95"].median()
    ax.plot(range(len(d)), d.values, marker=mk[s], lw=1.1, ms=4, label=lab[s], color=GRAY[s], ls=LS[s])
ax.set_xticks(range(4)); ax.set_xticklabels([10, 50, 200, 1000]); ax.set_yscale("log")
ax.set_xlabel("Concurrent requests (N)", fontsize=8); ax.set_ylabel("P95 latency (ms, median of runs)", fontsize=8)
ax.grid(alpha=.3, which="both"); ax.tick_params(labelsize=7); ax.legend(fontsize=6.5)
plt.tight_layout(); plt.savefig("figures/fig_p95.png", bbox_inches="tight")
print(json.dumps({k: out[k] for k in ["reps", "runs"]}))
print(t2.round(2).to_string())

# ---------------- Round 2 (after the fix) ----------------
C = pd.DataFrame([json.loads(l) for l in open("data/final_C.jsonl")])
C["excess"] = C["booked"] - C["rooms_used"]; C["ideal"] = np.minimum(C["N"], C["R"])
C["lost_pct"] = 100 * C["lost_sales"] / C["ideal"]; C["err_pct"] = 100 * C["error"] / C["N"]
C["timeouts"] = C["err_codes"].apply(lambda d: d.get("57014", 0)); C["deadlocks"] = C["err_codes"].apply(lambda d: d.get("40P01", 0))
def summ(df):
    return {"runs": int(len(df)), "oversell_runs": int((df["excess"] > 0).sum()), "lost_mean": float(df["lost_pct"].mean()), "lost_max": float(df["lost_pct"].max()),
            "runs_with_loss": int((df["lost_sales"] > 0).sum()), "err_mean": float(df["err_pct"].mean()), "deadlocks": int(df["deadlocks"].sum()), "timeouts": int(df["timeouts"].sum()),
            "runs_with_err": int((df["error"] > 0).sum()), "p95_median": float(df["p95"].median())}
r2 = {}
for before, after, key in [("S1_constraint", "S1v2_direct_fixed", "direct"), ("S2_arun", "S2v2_ota_fixed", "ota")]:
    b = A[A.strategy == before]; a = C[C.strategy == after]
    U, p = stats.mannwhitneyu(b["lost_pct"], a["lost_pct"], alternative="two-sided")
    Up, pp = stats.mannwhitneyu(b["p95"], a["p95"], alternative="two-sided")
    r2[key] = {"before": summ(b), "after": summ(a), "mw_lost": {"U": float(U), "p": float(p), "r": round(1 - 2 * U / (len(a) * len(b)), 3)},
               "mw_p95": {"U": float(Up), "p": float(pp), "r": round(1 - 2 * Up / (len(a) * len(b)), 3)}}
out["round2"] = r2
json.dump(out, open("data/stats.json", "w"), ensure_ascii=False, indent=1, default=float)
print(json.dumps(r2, indent=1, default=float))
