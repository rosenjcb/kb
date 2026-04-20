import { describe, expect, it } from "vitest";
import {
    artifactPath,
    buildArtifact,
    computeDelta,
    type TaskArtifactOptions,
} from "../scripts/eval-task-artifact.js";
import type { Snapshot } from "../scripts/eval-snapshot.js";

const makeSnap = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    ts: "2026-04-20T00:00:00.000Z",
    today_cost: 10.0,
    today_calls: 100,
    month_cost: 50.0,
    month_calls: 500,
    ...overrides,
});

describe("computeDelta", () => {
    it("computes today delta when no midnight crossing", () => {
        const before = makeSnap({ today_cost: 10.0, today_calls: 100 });
        const after = makeSnap({ today_cost: 10.5, today_calls: 105 });
        const delta = computeDelta(before, after);
        expect(delta.cost).toBe(0.5);
        expect(delta.calls).toBe(5);
    });

    it("falls back to month delta when today delta is negative (midnight crossing)", () => {
        const before = makeSnap({ today_cost: 9.9, today_calls: 200, month_cost: 40.0, month_calls: 800 });
        const after = makeSnap({ today_cost: 0.5, today_calls: 5, month_cost: 40.6, month_calls: 806 });
        const delta = computeDelta(before, after);
        expect(delta.cost).toBe(0.6);
        expect(delta.calls).toBe(6);
    });

    it("rounds cost delta to 4 decimal places", () => {
        const before = makeSnap({ today_cost: 1.0 });
        const after = makeSnap({ today_cost: 1.00005 });
        const delta = computeDelta(before, after);
        expect(delta.cost).toBe(0.0001);
    });
});

describe("buildArtifact", () => {
    const baseOpts: TaskArtifactOptions = {
        before: makeSnap({ today_cost: 5.0, today_calls: 50 }),
        after: makeSnap({ today_cost: 5.3, today_calls: 53 }),
        taskId: 2,
        agent: "kb-backed",
        run: 1,
        base: "raylib",
        queriesMade: 2,
        submissionsMade: 1,
        completed: true,
        notes: "test run",
    };

    it("builds artifact with correct structure", () => {
        const a = buildArtifact(baseOpts);
        expect(a.task_id).toBe(2);
        expect(a.run).toBe(1);
        expect(a.agent).toBe("kb-backed");
        expect(a.base).toBe("raylib");
        expect(a.kb_queries_made).toBe(2);
        expect(a.kb_submissions_made).toBe(1);
        expect(a.codeburn_cost_usd_delta).toBe(0.3);
        expect(a.codeburn_calls_delta).toBe(3);
        expect(a.task_completed).toBe(true);
        expect(a.notes).toBe("test run");
    });

    it("sets base to null for raw agent", () => {
        const a = buildArtifact({ ...baseOpts, agent: "raw", base: null });
        expect(a.base).toBeNull();
    });
});

describe("artifactPath", () => {
    it("generates correct path", () => {
        const p = artifactPath("/repo", "2026-04-20", 3, 4, "raw");
        expect(p).toBe("/repo/evaluation/runs/agent-compare/2026-04-20-run3-task-4-raw.json");
    });
});
