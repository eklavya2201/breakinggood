import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicPlan, nodeDefaultPort, type RepoFacts } from "./detect-stack.js";

test("maps common Node frameworks to their default dev ports", () => {
  assert.equal(nodeDefaultPort({ dependencies: { next: "14.0.0" } }), 3000);
  assert.equal(nodeDefaultPort({ dependencies: { "react-scripts": "5.0.1" } }), 3000);
  assert.equal(nodeDefaultPort({ devDependencies: { vite: "5.0.0" } }), 5173);
  assert.equal(nodeDefaultPort({ devDependencies: { "@sveltejs/kit": "2.0.0" } }), 5173);
  assert.equal(nodeDefaultPort({ dependencies: { astro: "4.0.0" } }), 4321);
  assert.equal(nodeDefaultPort({ dependencies: { "@angular/core": "17.0.0" } }), 4200);
  assert.equal(nodeDefaultPort({ dependencies: { gatsby: "5.0.0" } }), 8000);
  assert.equal(nodeDefaultPort({ dependencies: { expo: "50.0.0" } }), 8081);
});

test("returns nothing for a plain Node project", () => {
  assert.equal(nodeDefaultPort({ dependencies: { express: "4.0.0" } }), undefined);
  assert.equal(nodeDefaultPort({}), undefined);
});

test("heuristicPlan fills ports for a Node repo", () => {
  const facts: RepoFacts = {
    dir: "/nonexistent",
    tree: "",
    readme: "",
    stack: "node",
    packageJson: { scripts: { dev: "vite" }, devDependencies: { vite: "5.0.0" } },
  };
  assert.deepEqual(heuristicPlan(facts).ports, [5173]);
});
