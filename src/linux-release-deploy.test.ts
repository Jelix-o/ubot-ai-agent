import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const deployer = readFileSync(path.resolve("scripts", "deploy-linux-release.sh"), "utf8");
const networkConfigurator = readFileSync(path.resolve("scripts", "configure-v3-network.mjs"), "utf8");
const ingressUnit = readFileSync(path.resolve("deploy", "systemd", "ubot-ingress.service.template"), "utf8");
const workerUnit = readFileSync(path.resolve("deploy", "systemd", "ubot-worker.service.template"), "utf8");
const adminUnit = readFileSync(path.resolve("deploy", "systemd", "ubot-admin.service.template"), "utf8");
const targetUnit = readFileSync(path.resolve("deploy", "systemd", "ubot.target.template"), "utf8");
const maintenanceUnit = readFileSync(path.resolve("deploy", "systemd", "ubot-maintenance.service.template"), "utf8");
const maintenanceTimer = readFileSync(path.resolve("deploy", "systemd", "ubot-maintenance.timer.template"), "utf8");
const nginx = readFileSync(path.resolve("deploy", "nginx", "bot.9958.uk.conf"), "utf8");
const releaseWorkflow = readFileSync(path.resolve(".github", "workflows", "release.yml"), "utf8");
const ciWorkflow = readFileSync(path.resolve(".github", "workflows", "ci.yml"), "utf8");
const localPublisher = readFileSync(path.resolve("scripts", "publish-github-release.ps1"), "utf8");

test("V3 Linux deployer verifies assets, migrates once, and atomically selects current", () => {
  assert.match(deployer, /sha256sum/);
  assert.match(deployer, /matching downloaded GitHub Release assets/);
  assert.match(deployer, /validate_archive_paths/);
  assert.match(deployer, /\[\[ "\$entry" == "\.\/" \]\]/);
  assert.match(deployer, /verify-release-source\.mjs" "\$STAGING_DIR"/);
  assert.match(deployer, /VACUUM INTO/);
  assert.match(deployer, /persistent-files\.tar\.gz/);
  assert.match(deployer, /migrate-v3-state\.mjs" --execute/);
  assert.match(deployer, /UBOT_STATE_ENCRYPTION_KEY/);
  assert.doesNotMatch(deployer, /ADMIN_TOTP_ENCRYPTION_KEY/);
  assert.doesNotMatch(deployer, /ADMIN_SESSION_SECRET/);
  assert.match(deployer, /UBOT_HUIXIAN_PROFILE_PATH/);
  assert.match(deployer, /cutover_may_have_started=1/);
  assert.match(deployer, /Do not restart the legacy service/);
  assert.match(deployer, /restore_napcat_config/);
  assert.match(deployer, /restore_persistent_env/);
  assert.match(deployer, /restore_nginx_config/);
  assert.match(deployer, /mv -Tf .*CURRENT_LINK/);
  assert.match(deployer, /systemctl disable "\$LEGACY_SERVICE"/);
  assert.match(deployer, /systemctl start ubot\.target/);
  assert.match(deployer, /systemctl start ubot-maintenance\.timer/);
  assert.match(deployer, /UBOT_NGINX_CONFIG/);
  assert.match(deployer, /onebot11_428881701\.json/);
  assert.match(deployer, /network\.websocketClients\.0\.url/);
  assert.match(deployer, /NAPCAT_URL_PATH="network\.websocketClients\.0\.url"/);
  assert.match(deployer, /NAPCAT_REVERSE_URL" != "ws:\/\/172\.21\.0\.1:6199\/onebot\/ws"/);
  assert.match(deployer, /UBOT_NAPCAT_CONTAINER/);
  assert.match(deployer, /preflight_napcat_container/);
  assert.match(deployer, /docker inspect --type container --format '\{\{\.State\.Running\}\}'/);
  assert.match(deployer, /docker restart --time 30 "\$NAPCAT_CONTAINER"/);
  assert.match(deployer, /verify_updated_network_env/);
  assert.match(deployer, /ADMIN_HTTP_ENABLED.*true/);
  assert.match(deployer, /nginx -t/);
  assert.match(deployer, /status" != "401/);
});

test("V3 Linux deployer rejects inaccessible mutable state before stopping writers", () => {
  assert.match(deployer, /preflight_cutover_write_access\(\)/);
  assert.match(deployer, /require_mutable_directory/);
  assert.match(deployer, /require_atomically_replaceable_file/);
  assert.match(deployer, /require_sudo_mutable_directory/);
  assert.match(deployer, /require_sudo_atomically_replaceable_file/);
  assert.match(deployer, /PERSISTENT_ENV/);
  assert.match(deployer, /NAPCAT_CONFIG/);
  assert.match(deployer, /DB_PATH/);
  assert.match(deployer, /ROLLBACK_DIR/);
  assert.match(deployer, /LEGACY_SOURCE_PATHS/);
  assert.match(deployer, /preflight_legacy_skills_access/);
  assert.match(deployer, /Release root/);

  const preflightCall = deployer.lastIndexOf("preflight_cutover_write_access\n");
  const stopWriters = deployer.indexOf("# Stop all writers before backing up SQLite or reading legacy JSON files.");
  const cutover = deployer.indexOf("cutover_may_have_started=1");
  const rollbackArm = deployer.indexOf("rollback_armed=1", stopWriters);
  assert.ok(preflightCall >= 0, "deployer must invoke the mutable-path preflight");
  assert.ok(preflightCall < stopWriters, "mutable-path preflight must run before stopping writers");
  assert.ok(preflightCall < cutover, "mutable-path preflight must run before V3 cutover can start");
  assert.ok(rollbackArm > stopWriters && rollbackArm < cutover, "rollback must be armed before either writer is stopped");
});

test("V3 deployer safely updates a root-owned NapCat JSON through a validated staging copy", () => {
  assert.match(deployer, /NAPCAT_CONFIG_STAGING="\$BACKUP_DIR\/napcat-config\.v3\.json"/);
  assert.match(deployer, /cp "\$NAPCAT_CONFIG" "\$NAPCAT_CONFIG_STAGING"/);
  assert.match(deployer, /--napcat-config "\$NAPCAT_CONFIG_STAGING"/);
  assert.match(deployer, /install_napcat_config_atomically/);
  assert.match(deployer, /stat -c '%u:%g:%a' "\$NAPCAT_CONFIG"/);
  assert.match(deployer, /install -m "\$file_mode" -o "\$owner_id" -g "\$group_id"/);
  assert.match(deployer, /sudo -n mv -f "\$root_staging" "\$NAPCAT_CONFIG"/);
  assert.match(deployer, /napcat_restart_attempted=1/);
  assert.match(deployer, /restart_napcat_container \|\| echo "NapCat restart after configuration restore failed/);

  const v3Start = deployer.lastIndexOf("sudo systemctl start ubot.target");
  const napcatRestart = deployer.lastIndexOf("restart_napcat_container");
  assert.ok(v3Start >= 0 && napcatRestart > v3Start, "NapCat restarts only after V3 is started");
});

test("V3 infrastructure keeps process ownership and network exposure narrow", () => {
  for (const unit of [ingressUnit, workerUnit, adminUnit]) {
    assert.match(unit, /WorkingDirectory=\/opt\/ai-project-releases\/current/);
    assert.match(unit, /EnvironmentFile=\/opt\/ai-project\/\.env/);
    assert.match(unit, /ExecStart=\/usr\/bin\/env node dist\/index\.js/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /NoNewPrivileges=true/);
  }
  assert.match(ingressUnit, /BOT_ROLE=ingress/);
  assert.match(workerUnit, /BOT_ROLE=worker/);
  assert.match(adminUnit, /BOT_ROLE=admin/);
  assert.match(targetUnit, /Wants=ubot-ingress\.service ubot-worker\.service ubot-admin\.service/);
  assert.match(maintenanceUnit, /migrate-v3-state\.mjs --maintenance --execute/);
  assert.match(maintenanceTimer, /Description=Run UBot V3 retention maintenance hourly/);
  assert.match(maintenanceTimer, /OnCalendar=\*-\*-\* \*:17:00 UTC/);
  assert.match(networkConfigurator, /172\.21\.0\.1:6199/);
  assert.match(networkConfigurator, /approvedNapcatUrlPath/);
  assert.match(networkConfigurator, /network\.websocketClients\.0\.url/);
  assert.match(networkConfigurator, /writeAtomic/);
});

test("V3 release source verification restricts artifacts to the audited runtime allow-list", () => {
  const verifier = readFileSync(path.resolve("scripts", "verify-release-source.mjs"), "utf8");
  const linuxPackager = readFileSync(path.resolve("scripts", "package-linux-release.sh"), "utf8");
  const windowsPackager = readFileSync(path.resolve("scripts", "package-win.ps1"), "utf8");

  assert.match(verifier, /approvedStaticFiles/);
  assert.match(verifier, /not an approved release path/);
  assert.match(verifier, /\.sqlite-wal/);
  assert.match(linuxPackager, /npm ci --omit=dev --ignore-scripts/);
  assert.match(windowsPackager, /npm ci --omit=dev --ignore-scripts/);
  assert.match(windowsPackager, /set "NODE_ENV=production"/);
  for (const document of ["MIGRATION-v3.md", "ROLLBACK-v3.md"]) {
    const pathPattern = new RegExp(`docs/${document.replace(".", "\\.")}`);
    assert.match(verifier, pathPattern);
    assert.match(linuxPackager, pathPattern);
    assert.match(windowsPackager, pathPattern);
  }
});

test("formal release publication is gated to the matching final tag", () => {
  assert.match(releaseWorkflow, /needs: \[package-windows, package-linux\]/);
  assert.match(releaseWorkflow, /!contains\(github\.ref_name, '-'\)/);
  assert.match(releaseWorkflow, /matching v\$VERSION tag/);
  assert.match(releaseWorkflow, /verify-release-assets\.mjs/);
  assert.match(localPublisher, /Only a final semantic package version/);
  assert.match(localPublisher, /Formal GitHub Release tag must match package\.json exactly/);
  assert.match(localPublisher, /Current checkout must be the exact \$Tag commit/);
});

test("continuous integration validates the complete suite on Windows and Linux", () => {
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /ubuntu-latest/);
  assert.match(ciWorkflow, /windows-latest/);
  assert.match(ciWorkflow, /node-version: "22"/);
  assert.match(ciWorkflow, /npm ci/);
  assert.match(ciWorkflow, /npm test/);
});

test("V3 Nginx terminates HTTPS and does not trust client forwarded protocol", () => {
  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:6200/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto https/);
  assert.doesNotMatch(nginx, /\$http_x_forwarded_proto/);
  assert.match(nginx, /Content-Security-Policy/);
  assert.match(nginx, /location ~ \^\/\(\?:\\\.env/);
  assert.doesNotMatch(nginx, /assets\(\?:\/\|\$\)/);
});
