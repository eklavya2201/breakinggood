import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type Stack =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "php"
  | "java"
  | "dotnet"
  | "docker"
  | "static"
  | "unknown";

export interface Command {
  cmd: string;
  args: string[];
  /** Human-readable label. */
  label: string;
}

export interface RunPlan {
  stack: Stack;
  packageManager?: string;
  install: Command[];
  run: Command | null;
  /** Ports we expect, if known. */
  ports: number[];
  /** Why we chose this — printed for the user. */
  reasons: string[];
  /** Low confidence → we'll ask the AI to double-check if available. */
  confident: boolean;
}

export interface RepoFacts {
  dir: string;
  tree: string;
  readme: string;
  packageJson?: Record<string, unknown>;
  stack: Stack;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "target", "__pycache__", ".venv", "venv"]);

export function fileTree(dir: string, maxEntries = 400): string {
  const lines: string[] = [];
  const walk = (d: string, depth: number) => {
    if (lines.length >= maxEntries || depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e)) continue;
      const full = path.join(d, e);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      lines.push(isDir ? rel + "/" : rel);
      if (isDir) walk(full, depth + 1);
      if (lines.length >= maxEntries) return;
    }
  };
  walk(dir, 0);
  return lines.join("\n");
}

export function readFacts(dir: string): RepoFacts {
  const readmeName = readdirSync(dir).find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f));
  const readme = readmeName ? readFileSync(path.join(dir, readmeName), "utf8").slice(0, 12000) : "";
  let packageJson: Record<string, unknown> | undefined;
  if (existsSync(path.join(dir, "package.json"))) {
    try {
      packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      /* malformed */
    }
  }
  const facts: RepoFacts = { dir, tree: fileTree(dir), readme, packageJson, stack: "unknown" };
  facts.stack = detectStack(facts);
  return facts;
}

function detectStack(f: RepoFacts): Stack {
  const has = (p: string) => existsSync(path.join(f.dir, p));
  if (f.packageJson) return "node";
  if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile") || has("setup.py") || has("manage.py")) return "python";
  if (has("go.mod")) return "go";
  if (has("Cargo.toml")) return "rust";
  if (has("Gemfile")) return "ruby";
  if (has("composer.json") || has("artisan")) return "php";
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) return "java";
  if (readdirSync(f.dir).some((x) => /\.(csproj|sln)$/.test(x))) return "dotnet";
  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yml") || has("compose.yaml")) return "docker";
  if (has("index.html")) return "static";
  return "unknown";
}

function nodePackageManager(dir: string, pkg: Record<string, unknown>): string {
  const pm = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (pm) return pm;
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Heuristic plan. The AI planner refines it when the heuristics are unsure. */
/** Default dev-server ports by dependency, checked in order. First match wins. */
const NODE_PORTS: [string[], number][] = [
  [["next", "nuxt", "nuxt3", "@remix-run/dev", "@remix-run/react", "react-scripts"], 3000],
  [["vite", "@sveltejs/kit"], 5173],
  [["astro"], 4321],
  [["@angular/core", "@angular/cli"], 4200],
  [["gatsby"], 8000],
  [["expo"], 8081],
];

/** Guess the dev-server port of a Node project from its dependencies. */
export function nodeDefaultPort(pkg: Record<string, unknown>): number | undefined {
  const deps = {
    ...((pkg.dependencies ?? {}) as Record<string, unknown>),
    ...((pkg.devDependencies ?? {}) as Record<string, unknown>),
  };
  return NODE_PORTS.find(([names]) => names.some((n) => n in deps))?.[1];
}

export function heuristicPlan(f: RepoFacts): RunPlan {
  const plan: RunPlan = { stack: f.stack, install: [], run: null, ports: [], reasons: [], confident: false };
  const d = f.dir;
  const has = (p: string) => existsSync(path.join(d, p));

  switch (f.stack) {
    case "node": {
      const pkg = f.packageJson!;
      const pm = nodePackageManager(d, pkg);
      plan.packageManager = pm;
      const installArgs = pm === "yarn" ? [] : ["install"];
      plan.install.push({ cmd: pm, args: installArgs, label: `${pm} install` });
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const pick = ["dev", "start", "serve", "preview", "start:dev", "develop"].find((s) => scripts[s]);
      if (pick) {
        const runArgs = pm === "npm" && pick !== "start" ? ["run", pick] : pm === "npm" ? ["start"] : [pick];
        plan.run = { cmd: pm, args: runArgs, label: `${pm} ${runArgs.join(" ")}` };
        plan.reasons.push(`package.json has a "${pick}" script: ${scripts[pick]}`);
        plan.confident = true;
      } else if (typeof pkg.main === "string") {
        plan.run = { cmd: "node", args: [pkg.main], label: `node ${pkg.main}` };
        plan.reasons.push(`no dev/start script; falling back to package.json "main"`);
      }
      const port = nodeDefaultPort(pkg);
      if (port) plan.ports.push(port);
      if (scripts.build && !scripts.dev && scripts.start) {
        plan.install.push({ cmd: pm, args: pm === "npm" ? ["run", "build"] : ["build"], label: `${pm} build` });
        plan.reasons.push(`"start" without "dev" → building first`);
      }
      break;
    }
    case "python": {
      const py = process.platform === "win32" ? "python" : "python3";
      const venvPy = process.platform === "win32" ? ".venv\\Scripts\\python.exe" : ".venv/bin/python";
      plan.install.push({ cmd: py, args: ["-m", "venv", ".venv"], label: "create .venv" });
      if (has("requirements.txt")) {
        plan.install.push({ cmd: venvPy, args: ["-m", "pip", "install", "-q", "-r", "requirements.txt"], label: "pip install -r requirements.txt" });
      } else if (has("pyproject.toml")) {
        plan.install.push({ cmd: venvPy, args: ["-m", "pip", "install", "-q", "-e", "."], label: "pip install -e ." });
      }
      const entry = ["manage.py", "app.py", "main.py", "server.py", "run.py", "wsgi.py"].find(has);
      if (entry === "manage.py") {
        plan.run = { cmd: venvPy, args: ["manage.py", "runserver"], label: "python manage.py runserver" };
        plan.ports.push(8000);
        plan.confident = true;
      } else if (entry) {
        plan.run = { cmd: venvPy, args: [entry], label: `python ${entry}` };
        plan.reasons.push(`found ${entry} at the repo root`);
      }
      break;
    }
    case "go":
      plan.install.push({ cmd: "go", args: ["mod", "download"], label: "go mod download" });
      plan.run = { cmd: "go", args: ["run", "."], label: "go run ." };
      plan.confident = has("main.go");
      break;
    case "rust":
      plan.run = { cmd: "cargo", args: ["run"], label: "cargo run" };
      plan.confident = true;
      break;
    
      case "ruby":
       plan.install.push({ cmd: "bundle", args: ["install"], label: "bundle install" });
       if (has("bin/rails") || has("config/application.rb")) {
       plan.run = { cmd: "bundle", args: ["exec", "rails", "server"], label: "rails server" };
       plan.ports.push(3000);
       plan.reasons.push("found bin/rails → Rails app");
       } else if (has("config.ru")) {
       plan.run = { cmd: "bundle", args: ["exec", "rackup"], label: "rackup" };
       plan.ports.push(9292);
       plan.reasons.push("config.ru without Rails → plain Rack app");
       }
       break;

    case "php":
      plan.install.push({ cmd: "composer", args: ["install"], label: "composer install" });
      plan.run = has("artisan")
        ? { cmd: "php", args: ["artisan", "serve"], label: "php artisan serve" }
        : { cmd: "php", args: ["-S", "localhost:8080"], label: "php -S localhost:8080" };
      plan.ports.push(has("artisan") ? 8000 : 8080);
      break;
    case "java":
      if (has("mvnw") || has("pom.xml")) plan.run = { cmd: has("mvnw") ? "./mvnw" : "mvn", args: ["spring-boot:run"], label: "mvn spring-boot:run" };
      else plan.run = { cmd: has("gradlew") ? "./gradlew" : "gradle", args: ["bootRun"], label: "gradle bootRun" };
      plan.ports.push(8080);
      break;
    case "dotnet":
      plan.run = { cmd: "dotnet", args: ["run"], label: "dotnet run" };
      break;
    case "docker":
      plan.run = { cmd: "docker", args: ["compose", "up"], label: "docker compose up" };
      plan.confident = true;
      break;
    case "static":
      plan.run = { cmd: "npx", args: ["--yes", "serve", "-l", "4173", "."], label: "serve index.html on :4173" };
      plan.ports.push(4173);
      plan.confident = true;
      break;
    default:
      break;
  }
  return plan;
}
