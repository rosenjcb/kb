#!/usr/bin/env tsx
/**
 * Capture a codeburn cost snapshot to a JSON file.
 * The delta between two snapshots = cost/calls consumed during one eval task.
 *
 * Usage:
 *   npm run eval:snap -- /tmp/snap-before.json
 *   tsx scripts/eval-snapshot.ts /tmp/snap-before.json
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export interface CodeburnStatus {
    currency: string;
    today: { cost: number; calls: number };
    month: { cost: number; calls: number };
}

export interface Snapshot {
    ts: string;
    today_cost: number;
    today_calls: number;
    month_cost: number;
    month_calls: number;
}

export function parseCodeburnStatus(raw: string): Snapshot {
    const d: CodeburnStatus = JSON.parse(raw);
    return {
        ts: new Date().toISOString(),
        today_cost: d.today.cost,
        today_calls: d.today.calls,
        month_cost: d.month.cost,
        month_calls: d.month.calls,
    };
}

export function captureSnapshot(): Snapshot {
    const raw = execSync("codeburn status --format json --provider claude", {
        encoding: "utf8",
    });
    return parseCodeburnStatus(raw);
}

export function writeSnapshot(snap: Snapshot, outPath: string): void {
    writeFileSync(outPath, `${JSON.stringify(snap, null, 2)}\n`, "utf8");
}

// --- CLI entry (only runs when executed directly, not when imported by tests) ---
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outPath = process.argv[2];
    if (!outPath) {
        console.error("Usage: eval-snapshot.ts <output-file>");
        process.exit(1);
    }
    const snap = captureSnapshot();
    writeSnapshot(snap, outPath);
    console.log(`snapshot -> ${outPath}`);
    console.log(`  today  $${snap.today_cost.toFixed(4)}  (${snap.today_calls} calls)`);
    console.log(`  month  $${snap.month_cost.toFixed(4)}  (${snap.month_calls} calls)`);
}
