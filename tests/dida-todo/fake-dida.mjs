#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const storePath = process.env.FAKE_DIDA_STORE;
if (!storePath) throw new Error("FAKE_DIDA_STORE required");
const args = process.argv.slice(2);
const load = () => JSON.parse(readFileSync(storePath, "utf8"));
const save = (data) => writeFileSync(storePath, JSON.stringify(data, null, 2));
const valueAfter = (name) => args[args.indexOf(name) + 1];

let data = load();
if (args[0] === "project" && args[1] === "list") {
  console.log(JSON.stringify(data.projects ?? [data.project].filter(Boolean)));
} else if (args[0] === "project" && args[1] === "create") {
  data.projects ??= [data.project].filter(Boolean);
  const project = {
    id: `project-${(data.projects.length ?? 0) + 1}`,
    name: valueAfter("--name"),
    kind: valueAfter("--kind") ?? "TASK",
    viewMode: valueAfter("--view-mode") ?? "list",
    closed: false,
  };
  data.projects.push(project); data.project ??= project; save(data); console.log(JSON.stringify(project));
} else if (args[0] === "project" && args[1] === "data") {
  console.log(JSON.stringify({ project: data.project, tasks: data.tasks.filter((task) => task.status === 0), columns: [] }));
} else if (args[0] === "task" && args[1] === "get") {
  const task = data.tasks.find((candidate) => candidate.id === args[3]);
  if (!task) process.exit(1);
  console.log(JSON.stringify(task));
} else if (args[0] === "task" && args[1] === "create") {
  const task = {
    id: `work-${data.nextTask++}`,
    projectId: valueAfter("--project"),
    title: valueAfter("--title"),
    content: valueAfter("--content"),
    status: 0,
    priority: 0,
    kind: "CHECKLIST",
    tags: (valueAfter("--tags") ?? "").split(",").filter(Boolean),
    items: JSON.parse(valueAfter("--items") ?? "[]").map((item) => ({ ...item, id: item.id ?? `item-${data.nextItem++}` })),
  };
  data.tasks.push(task); save(data); console.log(JSON.stringify(task));
} else if (args[0] === "task" && args[1] === "update") {
  const task = data.tasks.find((candidate) => candidate.id === args[2]);
  if (!task) process.exit(1);
  Object.assign(task, {
    title: valueAfter("--title"), content: valueAfter("--content"), priority: Number(valueAfter("--priority") ?? 0),
    tags: (valueAfter("--tags") ?? "").split(",").filter(Boolean),
    items: JSON.parse(valueAfter("--items") ?? "[]").map((item) => ({ ...item, id: item.id ?? `item-${data.nextItem++}` })),
  });
  save(data); console.log(JSON.stringify(task));
} else if (args[0] === "task" && args[1] === "complete") {
  const task = data.tasks.find((candidate) => candidate.id === args[3]);
  if (!task) process.exit(1);
  task.status = 2; save(data); console.log("任务已完成");
} else {
  console.error(`unsupported: ${args.join(" ")}`); process.exit(2);
}
