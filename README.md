# arun-oversell-benchmark

Benchmark scripts, raw results and analysis code for the paper

> **การพัฒนาและประเมินกลไกป้องกันการขายเกินในระบบจองห้องพัก**
> *Development and Evaluation of Overselling Prevention Mechanisms in a Hotel Reservation System*
> Therdpoom Phanich, 2026

The repository contains everything needed to reproduce the three experiments and every
number in the paper. It does **not** contain the source code of ARUN PMS itself, which is
proprietary; the two code changes evaluated in the paper are included as minimal diffs
under `patches/`.

**คู่มือภาษาไทยฉบับละเอียด (ติดตั้ง รัน เทียบผล เพิ่มกลยุทธ์ของตนเอง): [README.th.md](README.th.md)**

## Contents

| Path | What it is |
|---|---|
| `bench.mjs` | Benchmark driver (Node.js + `pg`). Implements strategies S0–S5 and the two post-fix variants S1′/S2′ as SQL against a scratch PostgreSQL database. |
| `analyze.py` | Statistics and figures (pandas/SciPy/matplotlib). Produces `data/stats.json` and the two figures. |
| `data/final_A.jsonl` | Experiment 1 raw results: 6 strategies × N ∈ {10,50,200,1000} × R ∈ {1,5,20} × 10 replications = 720 runs. |
| `data/final_B.jsonl` | Experiment 2 raw results: 4 modes × D ∈ {2,3,5} × 30 replications = 360 runs. |
| `data/final_C.jsonl` | Experiment 3 raw results: S1′ and S2′ × 12 conditions × 10 replications = 240 runs. |
| `data/stats.json` | All statistics reported in the paper (Kruskal–Wallis, Mann–Whitney U, Fisher's exact, before/after). |
| `patches/` | Unified diffs of the two commits that implement the improved mechanism (see below). |
| `CITATION.cff` | How to cite this repository. |

One line of `final_*.jsonl` = one run. Field names:

* Experiment A/C: `strategy, N, R, rep, booked, full, error, err_codes{SQLSTATE: count}, oversell_pairs, rooms_used, lost_sales, p50, p95, wall_ms`
* Experiment B: `mode, K, D, rep, reservations, duplicates, missing, p50, p95`

Definitions used by the paper (also implemented in `analyze.py`):

* **lost sales (%)** = `lost_sales / min(N, R) × 100`, where `lost_sales = min(N, R) − rooms_used`
* **overselling** = `oversell_pairs` (pairs of reservations on the same room with overlapping `[check_in, check_out)`)
* **errors** = requests that ended with an error after the strategy's own retries (`40P01` deadlock, `57014` statement timeout)
* **P95** = 95th percentile of per-request latency, measured from pool checkout to pool release (includes queueing, retries and failed requests)

## Environment used for the paper

* PostgreSQL 16.13 (Ubuntu 24.04), `statement_timeout = 10 s`, 2 vCPU / 7 GB
* Node.js 22.22.2, `pg` 8.23.1, connection pool 100
* Python 3 with pandas 3.0, SciPy 1.17.1, matplotlib

## Reproducing

```bash
# 1. a scratch PostgreSQL (any 14+ with btree_gist available). Example with Docker:
docker run -d --name pgbench -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:16

# 2. dependencies
npm install
pip install -r requirements.txt

# 3. experiments (the paper used REPS=10 for A and C, 30 for B)
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres STMT_TIMEOUT=10000
OUT=data/final_A.jsonl node bench.mjs A 10
OUT=data/final_B.jsonl node bench.mjs B 30
ONLY=S1v2_direct_fixed,S2v2_ota_fixed OUT=data/final_C.jsonl node bench.mjs A 10

# 4. statistics and figures
mkdir -p figures && python3 analyze.py
```

`bench.mjs` creates its own tables (`rooms`, `res_x`, `res_n`, `idem`) in the target database
and truncates them before every run; use an empty scratch database.

Environment variables: `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` (connection),
`POOL_MAX` (default 100), `STMT_TIMEOUT` ms (default 30000; the paper used 10000),
`ONLY` (comma-separated strategy keys), `OUT` (output file).

Strategy keys: `S0_naive S1_constraint S2_arun S3_serializable S4_rowlock S5_hybrid
S1v2_direct_fixed S2v2_ota_fixed`.

## Patches

The improved mechanism evaluated in Experiment 3 corresponds to two commits in the private
ARUN PMS repository. Only the changed hunks of the three affected files are published:

| Patch | Commit | Files |
|---|---|---|
| `patches/01-direct-path-repick.patch` | `cbcbd90e` (2026-10-01) | `server/routes/api/kiosk/book.post.ts`, `scripts/room-pick-race-check.mjs` |
| `patches/02-ota-path-skip-locked.patch` | `7088f672` (2026-10-01) | `server/utils/channex.ts` |

The pre-improvement baseline is commit `144bbd5e` (2026-09-20).

## Changelog

* **v1.1 (2026-10-03)** — adds `docs/appendix-stats.md` (full Kruskal–Wallis / Mann–Whitney / Fisher tables with Holm-adjusted p, sensitivity to the adjustment method, and distribution diagnostics) and `README.th.md`. Data, scripts and `data/stats.json` are unchanged from v1.0; every number in the paper is still reproducible from the v1.0 tag.
* **v1.0 (2026-10-02)** — benchmark scripts, raw results, analysis code and patches as used in the paper.

## Citation

> Phanich, T. (2026). *arun-oversell-benchmark: concurrency benchmark for room-overselling safeguards* (v1.0). Zenodo. https://doi.org/10.5281/zenodo.23100060

## License

MIT — see `LICENSE`. The ARUN PMS application itself is not covered by this license.
