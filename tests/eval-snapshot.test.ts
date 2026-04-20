import { describe, expect, it } from "vitest";
import { parseCodeburnStatus, type Snapshot } from "../scripts/eval-snapshot.js";

describe("parseCodeburnStatus", () => {
    it("parses valid codeburn status JSON", () => {
        const raw = JSON.stringify({
            currency: "USD",
            today: { cost: 12.34, calls: 100 },
            month: { cost: 99.99, calls: 500 },
        });
        const snap = parseCodeburnStatus(raw);
        expect(snap.today_cost).toBe(12.34);
        expect(snap.today_calls).toBe(100);
        expect(snap.month_cost).toBe(99.99);
        expect(snap.month_calls).toBe(500);
        expect(snap.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("throws on malformed JSON", () => {
        expect(() => parseCodeburnStatus("not json")).toThrow();
    });
});
