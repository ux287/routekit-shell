import { describe, expect, it } from "vitest";
import { deriveFsSearchSeed } from "../../src/retrievers/fs.js";
import {
  formatRange,
  isRenderablePassage,
  selectTopPassages,
  buildFindingsSection,
  buildActionsSection,
  buildPlanYaml,
  getLatestRunForProjectLabel,
  loadPlanYaml,
} from "../../packages/cli/src/planner/index.js";
import {
  appendProject,
  loadProjects,
  ensureProjectDirs,
  resolveScaffoldNotePath,
  applyScaffoldNoteActions,
  writeDendronConfig,
  writeVSCodeConfig,
  seedProjectTemplateNotes,
  getProjectRagRoot,
  getProjectSearchDirs,
} from "../../packages/cli/src/project/index.js";
import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";

describe("fsSearch helpers", () => {
  it("derives the first non-empty trimmed line", () => {
    const query = "\n\n  ${HOME}\n  second line\n";
    expect(deriveFsSearchSeed(query)).toBe("${HOME}");
  });

  it("caps the seed length to 200 characters", () => {
    const long = "a".repeat(500);
    expect(deriveFsSearchSeed(long)).toHaveLength(200);
  });
});

describe("planner source formatting helpers", () => {
  it("formats range correctly for start-only and start-end lines", () => {
    expect(formatRange(10, null)).toBe("10");
    expect(formatRange(5, 12)).toBe("5-12");
    expect(formatRange(null, null)).toBe("?");
  });

  it("filters out malformed passages", () => {
    expect(isRenderablePassage({ path: "", text: "hello" })).toBe(false);
    expect(isRenderablePassage({ path: "file.md", text: "" })).toBe(false);
    expect(isRenderablePassage({ path: "file.md", text: "snippet" })).toBe(true);
  });
});

describe("planner retrieval formatting", () => {
  const passages = [
    { path: "b.md", line_start: 5, line_end: 6, text: "bbb", score: 0.4 },
    { path: "a.md", line_start: 1, line_end: 1, text: "aaa", score: 0.9 },
    { path: "c.md", line_start: 2, line_end: 2, text: "ccc", score: 0.4 },
    { path: "a.md", line_start: 1, line_end: 1, text: "aaa-dup", score: 0.1 },
  ];

  it("selects top passages by score, then path/line", () => {
    const top = selectTopPassages(passages, 2);
    expect(top.map((p) => p.path)).toEqual(["a.md", "b.md"]);
  });

  it("builds findings section with snippets", () => {
    const text = buildFindingsSection(passages.slice(0, 1));
    expect(text).toContain("b.md:5-6");
    expect(text).toContain("bbb");
  });

  it("builds actions section with review checklist", () => {
    const text = buildActionsSection(passages.slice(0, 1));
    expect(text).toContain("Review `b.md:5-6`");
  });

  it("dedupes passages by path and line range", () => {
    const text = buildFindingsSection(passages);
    const occurrences = [...text.matchAll(/a\.md:1/g)].length;
    expect(occurrences).toBe(1);
  });

  it("handles empty passages with fallback", () => {
    expect(buildFindingsSection([])).toMatch(/No findings/);
    expect(buildActionsSection([])).toMatch(/Review problem statement/);
  });

  it("builds plan yaml object with findings/actions", () => {
    const state = {
      projectId: "proj-1",
      label: "kickoff",
      slug: "kickoff",
      createdAt: "2025-01-01T00:00:00.000Z",
      inputs: { problemText: "Problem line 1\nProblem line 2" },
    };
    const plan = buildPlanYaml(state, passages.slice(0, 2), { path: "notes/problem.md", text: "Problem line 1" });
    expect(plan.projectId).toBe("proj-1");
    expect(plan.problemPath).toBe("notes/problem.md");
    expect(plan.findings.length).toBe(2);
    expect(plan.actions.length).toBe(5); // 2 review + 3 scaffold-note
    expect(plan.actions[0].id).toContain("review");
    const scaffold = plan.actions.filter((a) => a.kind === "scaffold-note");
    expect(scaffold.map((a) => a.id)).toEqual([
      "scaffold-project-overview",
      "scaffold-discovery-interview",
      "scaffold-problem-backlog",
    ]);
  });
});

describe("run registry helpers", () => {
  it("returns the latest run for a project and label", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-run-"));
    const runsDir = path.join(tempRoot, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const indexPath = path.join(runsDir, "index.jsonl");
    const entries = [
      {
        timestamp: "2025-01-01T00:00:00.000Z",
        label: "demo",
        slug: "demo",
        projectId: "proj-1",
        runFolder: "runs/old",
      },
      {
        timestamp: "2025-02-01T00:00:00.000Z",
        label: "demo",
        slug: "demo",
        projectId: "proj-1",
        runFolder: "runs/new",
      },
    ];
    fs.writeFileSync(indexPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const latest = getLatestRunForProjectLabel(tempRoot, "proj-1", "demo");
    expect(latest).not.toBeNull();
    expect(latest.runFolder).toBe("runs/new");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("loads plan.yaml from a run folder", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-"));
    const runDir = path.join(tempRoot, "runs", "demo-run");
    fs.mkdirSync(runDir, { recursive: true });
    const planPath = path.join(runDir, "plan.yaml");
    fs.writeFileSync(
      planPath,
      [
        "version: 1",
        "label: demo",
        "projectId: proj-1",
        "actions:",
        "  - id: review-test",
        "    kind: review",
        "    target: file:1",
        '    description: "check file"',
        "",
      ].join("\n")
    );
    const loaded = loadPlanYaml(runDir, tempRoot);
    expect(loaded?.plan?.label).toBe("demo");
    expect(loaded?.plan?.actions?.[0]?.id).toBe("review-test");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe("project registry helpers", () => {
  it("appends and loads projects using external root", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-test-"));
    const { projectDir, notesDir } = ensureProjectDirs("test-proj", tempRoot);
    const registryPath = path.join(tempRoot, "projects", "index.jsonl");
    appendProject(
      {
        id: "test-proj",
        name: "Test Project",
        type: "internal",
        root: projectDir,
        notesRoot: notesDir,
        createdAt: "2025-11-17T00:00:00.000Z",
      },
      process.cwd(),
      { registryPath }
    );
    const projects = loadProjects(process.cwd(), { registryPath });
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("test-proj");
    expect(projects[0].root).toBe(projectDir);
    expect(projects[0].notesRoot).toBe(notesDir);
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(fs.existsSync(notesDir)).toBe(true);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resolves scaffold note paths and creates notes", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-notes-"));
    const notesRoot = path.join(tempRoot, "proj", "notes");
    fs.mkdirSync(notesRoot, { recursive: true });
    const project = {
      id: "proj-1",
      notesRoot,
      client: "ClientCo",
      mission: "Do things",
      type: "internal",
    };
    expect(resolveScaffoldNotePath(project, "project-overview")).toBe(path.join(notesRoot, "project.overview.md"));
    expect(resolveScaffoldNotePath(project, "discovery-interview")).toBe(path.join(notesRoot, "discovery.interview.kickoff.md"));
    expect(resolveScaffoldNotePath(project, "problem-backlog")).toBe(path.join(notesRoot, "backlog.problems.md"));

    const actions = [
      { kind: "scaffold-note", target: "project-overview" },
      { kind: "scaffold-note", target: "discovery-interview" },
      { kind: "scaffold-note", target: "problem-backlog" },
    ];
    const res = applyScaffoldNoteActions(project, actions, { createdAt: "2025-01-01T00:00:00.000Z" });
    expect(res.created).toHaveLength(3);
    for (const p of res.created) {
      expect(fs.existsSync(p)).toBe(true);
      const content = fs.readFileSync(p, "utf8");
      expect(content).toContain("projectId: proj-1");
    }
    // Re-apply should report existing
    const res2 = applyScaffoldNoteActions(project, actions, { createdAt: "2025-01-01T00:00:00.000Z" });
    expect(res2.existing).toHaveLength(3);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes dendron config idempotently", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-dendron-"));
    const project = {
      id: "proj-1",
      root: tempRoot,
      notesRoot: path.join(tempRoot, "notes"),
    };
    fs.mkdirSync(project.notesRoot, { recursive: true });
    const first = writeDendronConfig(project);
    expect(fs.existsSync(first)).toBe(true);
    const content = fs.readFileSync(first, "utf8");
    expect(content).toMatch(/version:\s*1/);
    expect(content).toMatch(/fsPath:\s*notes/);
    const second = writeDendronConfig(project);
    expect(second).toBe(first);
    const content2 = fs.readFileSync(first, "utf8");
    expect(content2).toBe(content);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes VS Code config and does not overwrite existing files", () => {
    const prevRoot = process.env.ROUTEKIT_PROJECTS_ROOT;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-test-"));
    process.env.ROUTEKIT_PROJECTS_ROOT = tempRoot;
    const projectRoot = path.join(tempRoot, "proj-vscode");
    const project = {
      id: "proj-vscode",
      root: projectRoot,
      notesRoot: path.join(projectRoot, "notes"),
    };

    try {
      const { settingsPath, extensionsPath } = writeVSCodeConfig(project);
      expect(fs.existsSync(settingsPath)).toBe(true);
      expect(fs.existsSync(extensionsPath)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(settings["dendron.rootDir"]).toBe(".");
      expect(settings["dendron.defaultVault"]).toBe("notes");
      const extensions = JSON.parse(fs.readFileSync(extensionsPath, "utf8"));
      expect(Array.isArray(extensions.recommendations)).toBe(true);
      expect(extensions.recommendations).toContain("dendron.dendron");

      // Modify files to confirm subsequent runs do not overwrite
      fs.writeFileSync(settingsPath, JSON.stringify({ custom: true }, null, 2));
      fs.writeFileSync(extensionsPath, JSON.stringify({ recommendations: ["keep.me"] }, null, 2));
      const originalSettings = fs.readFileSync(settingsPath, "utf8");
      const originalExtensions = fs.readFileSync(extensionsPath, "utf8");

      writeVSCodeConfig(project);

      expect(fs.readFileSync(settingsPath, "utf8")).toBe(originalSettings);
      expect(fs.readFileSync(extensionsPath, "utf8")).toBe(originalExtensions);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECTS_ROOT;
      else process.env.ROUTEKIT_PROJECTS_ROOT = prevRoot;
    }
  });

  it("computes project RAG root", () => {
    const project = { id: "proj-rag", root: "/tmp/proj-rag" };
    expect(getProjectRagRoot(project)).toBe("/tmp/proj-rag/.routekit/lancedb/proj-rag.lancedb");
  });

  it("returns project search dirs that exist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-dirs-"));
    const project = {
      id: "proj-dirs",
      root: tempRoot,
      notesRoot: path.join(tempRoot, "notes"),
    };
    fs.mkdirSync(project.notesRoot, { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true });
    const dirs = getProjectSearchDirs(project);
    expect(dirs).toContain(project.notesRoot);
    expect(dirs).toContain(path.join(tempRoot, "src"));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("seeds content-cms template notes with substitutions", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-template-"));
    const notesRoot = path.join(tempRoot, "notes");
    fs.mkdirSync(notesRoot, { recursive: true });
    const project = {
      id: "proj-template",
      name: "Template Project",
      client: "ClientCo",
      template: "content-cms",
      root: tempRoot,
      notesRoot,
    };
    const { created } = await seedProjectTemplateNotes(project, { shellRoot: process.cwd() });
    expect(created.length).toBeGreaterThan(0);
    const overviewPath = path.join(notesRoot, "project.overview.md");
    expect(fs.existsSync(overviewPath)).toBe(true);
    const content = fs.readFileSync(overviewPath, "utf8");
    expect(content).toContain("Template Project");
    expect(content).toContain("proj-template");
    const kickoffPath = path.join(notesRoot, "drafts.plan.kickoff.md");
    expect(fs.existsSync(kickoffPath)).toBe(true);
    const kickoffParsed = matter.read(kickoffPath);
    expect(kickoffParsed.data.projectId).toBe("proj-template");
    expect(kickoffParsed.data.title).toContain("Kickoff Plan");
    expect(kickoffParsed.data.tags).toEqual(expect.arrayContaining(["kickoff", "planning", "proj-template"]));
    expect(kickoffParsed.content).toContain("project.overview.md");
    expect(kickoffParsed.content).toContain("discovery.interview.kickoff.md");
    expect(kickoffParsed.content).toContain("backlog.problems.md");

    const originalKickoff = fs.readFileSync(kickoffPath, "utf8");
    const again = await seedProjectTemplateNotes(project, { shellRoot: process.cwd() });
    expect(fs.readFileSync(kickoffPath, "utf8")).toBe(originalKickoff);
    expect(again.existing).toContain(kickoffPath);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
