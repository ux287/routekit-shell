import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { retrieveWithRouting } from "../src/router.js";
async function main() {
    const cfg = yaml.load(fs.readFileSync(path.join(".routekit", "retrieval.router.yaml"), "utf8"));
    const queries = [
        "retrieval",
        "function fsSearch",
        "Compare filesystem vs vector search trade-offs"
    ];
    for (const q of queries) {
        const { passages, trace, TRACE } = await retrieveWithRouting(q, cfg, null);
        console.log("\nQ:", q);
        console.log("TRACE:", TRACE, trace);
        console.log("PASSAGES:", passages.map(p => ({ source: p.source, path: p.path, score: p.score })).slice(0, 5));
    }
}
main();
