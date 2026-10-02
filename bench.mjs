// Oversell / duplicate-booking benchmark — controlled lab experiment on PostgreSQL 16.
// Reproduces the room-assignment write paths of ARUN PMS and common alternatives.
// Usage: node bench.mjs A|B [reps]
import pg from "pg";
import fs from "node:fs";

const POOL_MAX = Number(process.env.POOL_MAX || 100);
const pool = new pg.Pool({ host: process.env.PGHOST || "127.0.0.1", port: +(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres", password: process.env.PGPASSWORD, database: process.env.PGDATABASE || "postgres", max: POOL_MAX, options: "-c statement_timeout=" + (process.env.STMT_TIMEOUT || 30000) });
const CI = "2026-12-24", CO = "2026-12-26";

async function setup() {
  const c = await pool.connect();
  try {
    await c.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await c.query(`DROP TABLE IF EXISTS res_x, res_n, rooms, idem`);
    await c.query(`CREATE TABLE rooms (id serial PRIMARY KEY, room_type text NOT NULL, room_number text NOT NULL)`);
    for (const t of ["res_x", "res_n"]) {
      await c.query(`CREATE TABLE ${t} (id serial PRIMARY KEY, room_id int REFERENCES rooms(id), check_in date NOT NULL, check_out date NOT NULL,
        status text NOT NULL DEFAULT 'confirmed', source text, ota_booking_id text, ota_room_uid text, created_at timestamptz DEFAULT clock_timestamp())`);
      await c.query(`CREATE INDEX ON ${t}(room_id)`);
    }
    // Hard guard used by ARUN (db.ts): no two ACTIVE reservations on the same room with overlapping [check_in, check_out)
    await c.query(`ALTER TABLE res_x ADD CONSTRAINT res_x_no_overlap EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&) WHERE (status IN ('confirmed','checked-in'))`);
    // OTA de-dup key used by ARUN (channex.ts ON CONFLICT target)
    await c.query(`CREATE UNIQUE INDEX res_x_ota_uniq ON res_x (ota_booking_id, ota_room_uid) WHERE ota_booking_id IS NOT NULL AND ota_room_uid IS NOT NULL AND status <> 'cancelled'`);
    await c.query(`CREATE TABLE idem (key text PRIMARY KEY, reservation_id int, response jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
  } finally { c.release(); }
}

async function resetRooms(R) {
  await pool.query(`TRUNCATE res_x, res_n, idem RESTART IDENTITY`);
  await pool.query(`DELETE FROM rooms`);
  await pool.query(`ALTER SEQUENCE rooms_id_seq RESTART`);
  await pool.query(`INSERT INTO rooms (room_type, room_number) SELECT 'Deluxe', lpad(g::text,3,'0') FROM generate_series(1, ${R}) g`);
}

const FREE = (t, typ = "'Deluxe'") => `SELECT rm.id FROM rooms rm WHERE rm.room_type = ${typ}
  AND NOT EXISTS (SELECT 1 FROM ${t} r WHERE r.room_id = rm.id AND r.status IN ('confirmed','checked-in') AND r.check_in < $2::date AND r.check_out > $1::date)
  ORDER BY rm.room_number`;
const isOverlap = (e) => e?.code === "23P01";
const isSerial = (e) => e?.code === "40001" || e?.code === "40P01";

// Each strategy returns "booked" | "full" | "error"
const STRATEGIES = {
  // S0 check-then-insert in application code, no DB guard (typical naive implementation)
  S0_naive: async (c, src) => {
    const f = await c.query(FREE("res_n") + " LIMIT 1", [CI, CO]);
    if (!f.rows.length) return "full";
    await c.query(`INSERT INTO res_n (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [f.rows[0].id, CI, CO, src]);
    return "booked";
  },
  // S1 same two steps, but the DB exclusion constraint rejects the losing write (no retry → request fails)
  S1_constraint: async (c, src) => {
    const f = await c.query(FREE("res_x") + " LIMIT 1", [CI, CO]);
    if (!f.rows.length) return "full";
    try { await c.query(`INSERT INTO res_x (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [f.rows[0].id, CI, CO, src]); return "booked"; }
    catch (e) { if (isOverlap(e)) return "conflict"; throw e; }
  },
  // S2 ARUN: single-statement pick+insert (CTE) + exclusion constraint + retry up to 3 (channex.ts insertOtaRoomReservation)
  S2_arun: async (c, src) => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await c.query(`WITH picked AS (${FREE("res_x")} LIMIT 1)
          INSERT INTO res_x (room_id, check_in, check_out, source) SELECT picked.id, $1, $2, $3 FROM picked RETURNING id`, [CI, CO, src]);
        return r.rows.length ? "booked" : "full";
      } catch (e) { if (isOverlap(e)) continue; throw e; }
    }
    return "conflict";
  },
  // S3 SERIALIZABLE transaction around check-then-insert, retry up to 3 on serialization failure, no constraint
  S3_serializable: async (c, src) => {
    for (let a = 0; a < 3; a++) {
      try {
        await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const f = await c.query(FREE("res_n") + " LIMIT 1", [CI, CO]);
        if (!f.rows.length) { await c.query("COMMIT"); return "full"; }
        await c.query(`INSERT INTO res_n (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [f.rows[0].id, CI, CO, src]);
        await c.query("COMMIT");
        return "booked";
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); if (isSerial(e)) continue; throw e; }
    }
    return "conflict";
  },
  // S4 pessimistic row lock: lock a free room row (FOR UPDATE SKIP LOCKED) in READ COMMITTED, then insert, no constraint
  S4_rowlock: async (c, src) => {
    try {
      await c.query("BEGIN");
      const f = await c.query(FREE("res_n") + " LIMIT 1 FOR UPDATE OF rm SKIP LOCKED", [CI, CO]);
      if (!f.rows.length) { await c.query("COMMIT"); return "full"; }
      await c.query(`INSERT INTO res_n (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [f.rows[0].id, CI, CO, src]);
      await c.query("COMMIT");
      return "booked";
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  },
  // S5 proposed hybrid: S4's SKIP LOCKED room pick (no thundering herd) + ARUN's exclusion constraint as backstop, retry up to 3
  S5_hybrid: async (c, src) => {
    for (let a = 0; a < 3; a++) {
      try {
        await c.query("BEGIN");
        const f = await c.query(FREE("res_x") + " LIMIT 1 FOR UPDATE OF rm SKIP LOCKED", [CI, CO]);
        if (!f.rows.length) { await c.query("COMMIT"); return "full"; }
        await c.query(`INSERT INTO res_x (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [f.rows[0].id, CI, CO, src]);
        await c.query("COMMIT");
        return "booked";
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); if (isOverlap(e)) continue; throw e; }
    }
    return "conflict";
  },
};


// ---- Round 2: ARUN after the fix (2026-10-01), same SQL shape as the patched code ----
const FIXED = {
  // book.post.ts after fix: pick lowest free room (separate query), INSERT; on 23P01 re-pick a RANDOM free room
  // excluding rooms already lost in this request, up to 5 attempts in total
  S1v2_direct_fixed: async (c, src) => {
    const lost = [];
    let f = await c.query(FREE("res_x") + " LIMIT 1", [CI, CO]);
    if (!f.rows.length) return "full";
    let room = f.rows[0].id;
    for (let a = 0; ; a++) {
      try { await c.query(`INSERT INTO res_x (room_id, check_in, check_out, source) VALUES ($1,$2,$3,$4)`, [room, CI, CO, src]); return "booked"; }
      catch (e) {
        if (!isOverlap(e)) throw e;
        if (a >= 4) return "conflict";
        lost.push(room);
        const sqlTxt = FREE("res_x").replace("ORDER BY rm.room_number", "AND NOT (rm.id = ANY($3::int[])) ORDER BY CASE WHEN $4 THEN random() ELSE 0 END, rm.room_number");
        f = await c.query(sqlTxt + " LIMIT 1", [CI, CO, lost, true]);
        if (!f.rows.length) return "full";
        room = f.rows[0].id;
      }
    }
  },
  // channex.ts after fix: CTE pick with FOR UPDATE OF rm SKIP LOCKED + INSERT in ONE statement; empty → wait 50 ms and look again (max 3)
  S2v2_ota_fixed: async (c, src) => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await c.query(`WITH picked AS (${FREE("res_x")} LIMIT 1 FOR UPDATE OF rm SKIP LOCKED)
          INSERT INTO res_x (room_id, check_in, check_out, source) SELECT picked.id, $1, $2, $3 FROM picked RETURNING id`, [CI, CO, src]);
        if (r.rows.length) return "booked";
        if (a < 2) { await new Promise((z) => setTimeout(z, 50)); continue; }
        return "full";
      } catch (e) { if (isOverlap(e)) continue; throw e; }
    }
    return "conflict";
  },
};
Object.assign(STRATEGIES, FIXED);

function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; }

async function runA(strategy, N, R) {
  await resetRooms(R);
  const fn = STRATEGIES[strategy];
  const lat = []; const out = { booked: 0, full: 0, conflict: 0, error: 0 }; const codes = {};
  let go; const gate = new Promise((r) => (go = r));
  const t0 = performance.now();
  const jobs = Array.from({ length: N }, (_, i) => (async () => {
    await gate;
    const s = performance.now();
    const c = await pool.connect();
    try { out[await fn(c, i % 2 ? "direct" : "ota")]++; }
    catch (e) { out.error++; const k = e?.code || 'other'; codes[k] = (codes[k] || 0) + 1; }
    finally { c.release(); lat.push(performance.now() - s); }
  })());
  go();
  await Promise.all(jobs);
  const wall = performance.now() - t0;
  const t = strategy === "S0_naive" || strategy === "S3_serializable" || strategy === "S4_rowlock" ? "res_n" : "res_x";
  const ov = (await pool.query(`SELECT count(*)::int AS n FROM ${t} a JOIN ${t} b ON a.room_id = b.room_id AND a.id < b.id
      AND daterange(a.check_in,a.check_out,'[)') && daterange(b.check_in,b.check_out,'[)') AND a.status IN ('confirmed','checked-in') AND b.status IN ('confirmed','checked-in')`)).rows[0].n;
  const roomsUsed = (await pool.query(`SELECT count(DISTINCT room_id)::int AS n FROM ${t}`)).rows[0].n;
  const ideal = Math.min(N, R);
  return { exp: "A", strategy, N, R, ...out, err_codes: codes, oversell_pairs: ov, rooms_used: roomsUsed, lost_sales: ideal - roomsUsed,
    p50: pct(lat, 0.5), p95: pct(lat, 0.95), wall_ms: wall };
}

// ---- Experiment B: duplicate deliveries (OTA revision re-delivery and client retries) ----
async function runB(mode, K, D) {
  await pool.query(`TRUNCATE res_x, res_n, idem RESTART IDENTITY`); await pool.query(`DELETE FROM rooms`);
  await pool.query(`INSERT INTO rooms (room_type, room_number) SELECT 'T'||k, lpad(g::text,3,'0') FROM generate_series(0, ${K - 1}) k, generate_series(1, 5) g`);
  const lat = []; let go; const gate = new Promise((r) => (go = r));
  const jobs = [];
  for (let k = 0; k < K; k++) {
    const key = `bk${k}`.padEnd(20, "x"); const TY = `'T${k}'`;
    for (let d = 0; d < D; d++) jobs.push((async () => {
      await gate; const s = performance.now(); const c = await pool.connect();
      try {
        if (mode === "ota_none") {          // re-delivered revision inserted again (no de-dup key)
          await c.query(`WITH picked AS (${FREE("res_n", TY)} LIMIT 1) INSERT INTO res_n (room_id, check_in, check_out, source, ota_booking_id, ota_room_uid) SELECT picked.id,$1,$2,'ota',$3,'r0' FROM picked`, [CI, CO, key]);
        } else if (mode === "ota_arun") {   // ARUN: ON CONFLICT on (ota_booking_id, ota_room_uid) + exclusion constraint + retry
          for (let a = 0; a < 3; a++) {
            try {
              await c.query(`WITH picked AS (${FREE("res_x", TY)} LIMIT 1) INSERT INTO res_x (room_id, check_in, check_out, source, ota_booking_id, ota_room_uid) SELECT picked.id,$1,$2,'ota',$3,'r0' FROM picked
                ON CONFLICT (ota_booking_id, ota_room_uid) WHERE ota_booking_id IS NOT NULL AND ota_room_uid IS NOT NULL AND status <> 'cancelled' DO NOTHING`, [CI, CO, key]);
              break;
            } catch (e) { if (isOverlap(e)) continue; throw e; }
          }
        } else if (mode === "direct_none") { // client retries the same booking (lost response) — no idempotency key
          await c.query(`WITH picked AS (${FREE("res_x", TY)} LIMIT 1) INSERT INTO res_x (room_id, check_in, check_out, source, ota_booking_id) SELECT picked.id,$1,$2,'direct',$3 FROM picked`, [CI, CO, key]).catch((e) => { if (!isOverlap(e)) throw e; });
        } else if (mode === "direct_arun") { // ARUN booking-idempotency.ts: claim key first, replay/in-flight otherwise
          const ins = await c.query(`INSERT INTO idem (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`, [key]);
          if (ins.rows.length) {
            const r = await c.query(`WITH picked AS (${FREE("res_x", TY)} LIMIT 1) INSERT INTO res_x (room_id, check_in, check_out, source, ota_booking_id) SELECT picked.id,$1,$2,'direct',$3 FROM picked RETURNING id`, [CI, CO, key]);
            if (r.rows.length) await c.query(`UPDATE idem SET reservation_id=$2, response=$3 WHERE key=$1`, [key, r.rows[0].id, JSON.stringify({ id: r.rows[0].id })]);
          }
        }
      } finally { c.release(); lat.push(performance.now() - s); }
    })());
  }
  go(); await Promise.allSettled(jobs);
  const t = mode === "ota_none" ? "res_n" : "res_x";
  const rows = (await pool.query(`SELECT ota_booking_id, count(*)::int n FROM ${t} GROUP BY 1`)).rows;
  const dup = rows.reduce((a, r) => a + (r.n - 1), 0);
  const missing = K - rows.length;
  return { exp: "B", mode, K, D, reservations: rows.reduce((a, r) => a + r.n, 0), duplicates: dup, missing, p50: pct(lat, .5), p95: pct(lat, .95) };
}

const exp = process.argv[2] || "A"; const REPS = Number(process.argv[3] || 30);
await setup();
const outFile = process.env.OUT || `results_${exp}.jsonl`; fs.writeFileSync(outFile, "");
if (exp === "A") {
  for (let rep = 1; rep <= REPS; rep++)
    for (const N of [10, 50, 200, 1000]) for (const R of [1, 5, 20]) for (const s of (process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(STRATEGIES).filter((k) => !k.includes("v2")))) {
      const r = await runA(s, N, R); fs.appendFileSync(outFile, JSON.stringify({ rep, ...r }) + "\n");
    }
} else {
  for (let rep = 1; rep <= REPS; rep++)
    for (const D of [2, 3, 5]) for (const m of ["ota_none", "ota_arun", "direct_none", "direct_arun"]) {
      const r = await runB(m, 100, D); fs.appendFileSync(outFile, JSON.stringify({ rep, ...r }) + "\n");
    }
}
await pool.end();
console.log("done", exp);
