const { spawnSync } = require("node:child_process");

if (Number.parseInt(process.versions.node, 10) < 22) {
  const result = spawnSync(process.execPath, ["scripts/run-node22.cjs", __filename], {
    stdio: "inherit",
    shell: false,
  });
  process.exit(result.status ?? 1);
}

function run(label, args) {
  console.log(`\n> ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("server typecheck", ["node_modules/typescript/lib/tsc.js", "--noEmit", "-p", "tsconfig.json"]);
run("admin typecheck", ["node_modules/vue-tsc/bin/vue-tsc.js", "--noEmit", "-p", "admin/tsconfig.json"]);
