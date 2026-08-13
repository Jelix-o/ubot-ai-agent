const { spawnSync } = require("node:child_process");

if (Number.parseInt(process.versions.node, 10) < 22) {
  const result = spawnSync(process.execPath, ["scripts/run-node22.cjs", __filename], {
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

const node = process.execPath;

function run(label, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(node, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("clean:dist", ["scripts/clean-dist.cjs"]);
run("build:admin", ["node_modules/vite/bin/vite.js", "build", "--config", "admin/vite.config.ts"]);
run("build:server", ["node_modules/typescript/lib/tsc.js", "-p", "tsconfig.json"]);
