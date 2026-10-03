import { execa } from "execa";
import fs from "fs";
import path from "path";
const MAX_RESULTS = 1000;
const MAX_QUERY_PREVIEW = 200;
/**
 * Perform a literal ripgrep search for the given query, returning normalized passages.
 * The query is treated as a literal string (via --fixed-strings) to avoid regex injection.
 */
export async function fsSearch(rawQuery, opts) {
    const providedDirs = Array.isArray(opts?.searchDirs) ? opts.searchDirs : [];
    const defaultDirs = ["notes", "src"].map(dir => path.resolve(dir));
    const searchDirs = (providedDirs.length ? providedDirs : defaultDirs).filter(dir => fs.existsSync(dir));
    if (searchDirs.length === 0)
        return [];
    const sanitizedQuery = deriveFsSearchSeed(rawQuery);
    if (!sanitizedQuery)
        return [];
    const args = [
        "--json",
        "--no-ignore",
        "--hidden",
        "--with-filename",
        "--line-number",
        "--color",
        "never",
        "--fixed-strings",
        sanitizedQuery,
        ...searchDirs,
    ];
    try {
        const { stdout, stderr, exitCode } = await execa("rg", args, { timeout: opts.t, reject: false });
        if (exitCode === 1 || stdout.trim() === "")
            return [];
        if (exitCode && exitCode > 1) {
            return {
                error: {
                    source: "fs",
                    code: "RG_EXEC_ERROR",
                    message: stderr?.trim() || `ripgrep exited with code ${exitCode}`,
                },
            };
        }
        const lines = stdout.split("\n").filter(Boolean);
        const results = lines
            .map(parseRipgrepJsonLine)
            .filter(Boolean)
            .slice(0, MAX_RESULTS);
        return dedupeAndFormat(results).slice(0, opts.k);
    }
    catch (error) {
        return {
            error: {
                source: "fs",
                code: "RG_SPAWN_ERROR",
                message: error instanceof Error ? error.message : String(error),
            },
        };
    }
}
export function deriveFsSearchSeed(raw) {
    if (!raw)
        return "";
    // TODO: consider summarizing multiple salient lines instead of taking the first one.
    const trimmed = raw.toString().replace(/\r/g, "\n").split("\n").map(line => line.trim()).filter(Boolean)[0] || "";
    return trimmed.slice(0, MAX_QUERY_PREVIEW);
}
function parseRipgrepJsonLine(line) {
    try {
        const payload = JSON.parse(line);
        if (payload.type !== "match")
            return null;
        const pathText = payload.data?.path?.text || "";
        const lineStart = payload.data?.line_number ?? null;
        const snippet = (payload.data?.lines?.text || "").replace(/\r?\n/g, " ").trim();
        if (!pathText || !snippet)
            return null;
        return {
            source: "fs",
            path: pathText,
            line_start: lineStart,
            line_end: lineStart,
            text: snippet,
            score: Math.min(1, 0.5 + Math.min(0.5, snippet.length / 400)),
        };
    }
    catch {
        return null;
    }
}
function dedupeAndFormat(results) {
    const map = new Map();
    for (const res of results) {
        const key = `${res.path}:${res.line_start}:${res.text.slice(0, 80)}`;
        if (!map.has(key)) {
            map.set(key, res);
        }
    }
    return [...map.values()].sort((a, b) => {
        if (a.path === b.path)
            return a.line_start - b.line_start;
        return a.path.localeCompare(b.path);
    });
}
