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
const previewNginx = readFileSync(path.resolve("deploy", "nginx", "ubot-preview-static.conf"), "utf8");
const cloudflareAllowlistUpdater = readFileSync(path.resolve("scripts", "update-cloudflare-origin-allowlist.sh"), "utf8");
const cloudflareOriginInstaller = readFileSync(path.resolve("scripts", "install-cloudflare-origin-hardening.sh"), "utf8");
const nodeRuntimeInstaller = readFileSync(path.resolve("scripts", "install-node22-runtime.sh"), "utf8");
const releaseArchiveValidator = readFileSync(path.resolve("scripts", "validate-release-archive.mjs"), "utf8");
const releaseZipValidator = readFileSync(path.resolve("scripts", "validate-release-zip.mjs"), "utf8");
const cloudflareAllowlistUnit = readFileSync(path.resolve("deploy", "systemd", "ubot-cloudflare-allowlist.service.template"), "utf8");
const releaseWorkflow = readFileSync(path.resolve(".github", "workflows", "release.yml"), "utf8");
const ciWorkflow = readFileSync(path.resolve(".github", "workflows", "ci.yml"), "utf8");

test("V3 Linux deployer verifies assets, migrates once, and atomically selects current", () => {
  assert.match(deployer, /sha256sum/);
  assert.match(deployer, /matching downloaded GitHub Release assets/);
  assert.match(deployer, /releases\/\$release_id\/assets\?per_page=100/);
  assert.match(deployer, /GitHub can briefly serve a release object with an empty embedded `assets`/);
  assert.match(deployer, /GitHub Release asset list is invalid for the requested version/);
  assert.match(deployer, /Number\.isSafeInteger\(release\.id\)/);
  assert.match(deployer, /Array\.isArray\(assets\)/);
  assert.match(deployer, /assets_path="\$\(mktemp\)"/);
  assert.match(deployer, /validate_archive_paths/);
  assert.match(deployer, /validate-release-archive\.mjs/);
  assert.match(deployer, /stage_release_inputs\(\)/);
  assert.match(deployer, /cp --no-dereference -- "\$BUNDLE_SOURCE" "\$BUNDLE_STAGED_PATH"/);
  assert.match(deployer, /BUNDLE_STAGING_DIR="\$\(mktemp -d "\$RELEASE_ROOT\/\.incoming-v\$\{VERSION\}\.XXXXXX"\)"/);
  assert.match(deployer, /trap 'cleanup_staged_release_inputs' EXIT/);
  assert.match(deployer, /--no-same-owner --no-same-permissions --delay-directory-restore/);
  assert.match(deployer, /verify-release-source\.mjs" "\$STAGING_DIR"/);
  assert.match(deployer, /--headquarters-review-env "\$PERSISTENT_ENV"/);
  assert.match(deployer, /prepare_release_bundle_preflight/);
  assert.match(deployer, /VACUUM INTO/);
  assert.match(deployer, /persistent-files\.tar\.gz/);
  assert.match(deployer, /migrate-v3-state\.mjs" --execute --allow-existing-cutover/);
  assert.match(deployer, /UBOT_STATE_ENCRYPTION_KEY/);
  assert.doesNotMatch(deployer, /ADMIN_TOTP_ENCRYPTION_KEY/);
  assert.doesNotMatch(deployer, /ADMIN_SESSION_SECRET/);
  assert.match(deployer, /UBOT_HUIXIAN_PROFILE_PATH/);
  assert.match(deployer, /cutover_may_have_started=1/);
  assert.match(deployer, /has_existing_v3_cutover\(\)/);
  assert.match(deployer, /existing_cutover_before_deploy=1/);
  assert.match(deployer, /existing_cutover_before_deploy" -eq 1/);
  assert.match(deployer, /Once V3 has committed its cutover marker, upgrade releases must not scan/);
  assert.match(deployer, /backup_inputs\+=\(data\/shared\)/);
  assert.match(deployer, /Do not restart the legacy service/);
  assert.match(deployer, /restore_napcat_config/);
  assert.match(deployer, /restore_persistent_env/);
  assert.match(deployer, /restore_preview_nginx_files/);
  assert.match(deployer, /mv -Tf .*CURRENT_LINK/);
  assert.match(deployer, /systemctl disable "\$LEGACY_SERVICE"/);
  assert.match(deployer, /systemctl start ubot\.target/);
  assert.match(deployer, /systemctl start ubot-maintenance\.timer/);
  assert.match(deployer, /PREVIEW_NGINX_CONFIG="\/etc\/nginx\/sites-available\/preview-9958"/);
  assert.match(deployer, /PREVIEW_NGINX_INCLUDE="\/etc\/nginx\/ubot-preview-static\.conf"/);
  assert.match(deployer, /PREVIEW_NGINX_ENABLED_LINK="\/etc\/nginx\/sites-enabled\/preview-9958"/);
  assert.match(deployer, /onebot11_428881701\.json/);
  assert.match(deployer, /network\.websocketClients\.0\.url/);
  assert.match(deployer, /NAPCAT_URL_PATH="network\.websocketClients\.0\.url"/);
  assert.match(deployer, /NAPCAT_REVERSE_URL" != "ws:\/\/172\.21\.0\.1:6199\/onebot\/ws"/);
  assert.match(deployer, /UBOT_NAPCAT_CONTAINER/);
  assert.match(deployer, /preflight_napcat_container/);
  assert.match(deployer, /docker inspect --type container --format '\{\{\.State\.Running\}\}'/);
  assert.match(deployer, /docker restart --time 30 "\$NAPCAT_CONTAINER"/);
  assert.match(deployer, /verify_updated_network_env/);
  assert.match(deployer, /normalize-dotenv-bom\.mjs/);
  assert.match(deployer, /env\.before-bom-normalization/);
  assert.match(deployer, /ADMIN_HTTP_ENABLED.*true/);
  assert.match(deployer, /INGRESS_READ_API_TOKEN/);
  assert.match(deployer, /configure-v3-network\.mjs" \\\n+  --ingress-token-only \\\n+  --env "\$PERSISTENT_ENV"/);
  assert.match(deployer, /Run the production deployer as root/);
  assert.match(deployer, /install-node22-runtime\.sh/);
  assert.match(deployer, /The application-scoped Node 22 runtime is unavailable or invalid/);
  assert.match(deployer, /REQUIRED_PREVIEW_ROOT="\/var\/lib\/ubot-preview"/);
  assert.match(deployer, /RUNTIME_USER="ubot"/);
  assert.match(deployer, /chown root:"\$RUNTIME_GROUP" "\$PERSISTENT_ENV"/);
  assert.match(deployer, /chmod 0640 "\$PERSISTENT_ENV"/);
  assert.match(deployer, /nginx -t/);
  assert.match(deployer, /PREVIEW_CERTIFICATE="\/etc\/ssl\/cloudflare\/preview\.9958\.uk\.pem"/);
  assert.match(deployer, /PREVIEW_CERTIFICATE_KEY="\/etc\/ssl\/cloudflare\/preview\.9958\.uk\.key"/);
  assert.match(deployer, /preflight_origin_certificate "\$BOT_CERTIFICATE" "\$BOT_CERTIFICATE_KEY" "bot\.9958\.uk" "Bot"/);
  assert.match(deployer, /preflight_origin_certificate "\$PREVIEW_CERTIFICATE" "\$PREVIEW_CERTIFICATE_KEY" "preview\.9958\.uk" "Preview"/);
  assert.match(deployer, /harden_release_tree\(\)/);
  assert.match(deployer, /preflight_cloudflare_origin_boundary\(\)/);
  assert.match(deployer, /CLOUDFLARE_ORIGIN_READY_MARKER/);
  assert.match(deployer, /wait_for_ingress_read_api_listener\(\)/);
  assert.match(deployer, /wait_for_ingress_read_api_health\(\)/);
  assert.match(deployer, /wait_for_admin_auth_boundary\(\)/);
  assert.match(deployer, /verify_service_restart_counts_stable\(\)/);
  assert.match(deployer, /curl_config="\$\(mktemp "\$\{TMPDIR\}\/ubot-ingress-read-health\.XXXXXX"\)"/);
  assert.match(deployer, /--config "\$curl_config"/);
  assert.doesNotMatch(deployer, /-H "Authorization: Bearer \$INGRESS_READ_API_TOKEN"/);
  assert.match(deployer, /expectedStatus === "listener" \|\| parsed\.ok === true/);
  assert.match(deployer, /typeof parsed\.ok === "boolean"/);
  assert.match(deployer, /NRestarts/);
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
  const releaseBundlePreflight = deployer.lastIndexOf("prepare_release_bundle_preflight\n");
  const bomNormalization = deployer.indexOf('node "$DEPLOY_SCRIPT_DIR/normalize-dotenv-bom.mjs"');
  const stopWriters = deployer.indexOf("# Stop all writers before backing up SQLite or reading legacy JSON files.");
  const cutover = deployer.indexOf("cutover_may_have_started=1");
  const ingressTokenNormalization = deployer.indexOf("--ingress-token-only");
  const rollbackArm = deployer.indexOf("rollback_armed=1", stopWriters);
  const runtimeAccount = deployer.lastIndexOf("ensure_runtime_account\n");
  const releaseHardening = deployer.lastIndexOf("harden_release_tree\n");
  const cloudflarePreflight = deployer.lastIndexOf("preflight_cloudflare_origin_boundary\n");
  assert.ok(preflightCall >= 0, "deployer must invoke the mutable-path preflight");
  assert.ok(releaseBundlePreflight >= 0, "deployer must validate the release bundle before cutover");
  assert.ok(preflightCall < stopWriters, "mutable-path preflight must run before stopping writers");
  assert.ok(releaseBundlePreflight < stopWriters, "compiled release verification must run before stopping writers");
  assert.ok(bomNormalization >= 0 && bomNormalization < stopWriters, "dotenv BOM normalization must finish before stopping writers");
  assert.ok(preflightCall < cutover, "mutable-path preflight must run before V3 cutover can start");
  assert.ok(ingressTokenNormalization >= 0 && ingressTokenNormalization < cutover, "the ingress Read API token must be normalized before V3 migration begins");
  assert.ok(rollbackArm > stopWriters && rollbackArm < cutover, "rollback must be armed before either writer is stopped");
  assert.ok(runtimeAccount >= 0 && runtimeAccount < stopWriters, "runtime account must be validated before stopping writers");
  assert.ok(releaseHardening >= 0 && releaseHardening < stopWriters, "release tree must be hardened before stopping writers");
  assert.ok(cloudflarePreflight >= 0 && cloudflarePreflight < stopWriters, "Cloudflare origin hardening must be checked before stopping writers");
});

test("V3 deployer enforces the runtime identity, preview boundary, and post-start health contract", () => {
  assert.match(deployer, /useradd --system --gid "\$RUNTIME_GROUP" --home-dir \/nonexistent --shell \/usr\/sbin\/nologin/);
  assert.match(deployer, /account_shell" != "\/usr\/sbin\/nologin"/);
  assert.match(deployer, /lock_status="\$\(passwd -S "\$RUNTIME_USER" \| awk '\{print \$2\}'\)"/);
  assert.match(deployer, /lock_status" != "L" && "\$lock_status" != "LK"/);
  assert.match(deployer, /for prohibited_group in sudo adm docker lxd/);
  assert.match(deployer, /validate_preview_storage_paths\(\)/);
  assert.match(deployer, /record_runtime_identity\(\)/);
  assert.match(deployer, /migrate_runtime_identity_after_backup\(\)/);
  assert.match(deployer, /verify_runtime_user_access\(\)/);
  assert.match(deployer, /restore_runtime_identity \|\|/);
  assert.match(deployer, /restore_preview_location \|\|/);
  assert.match(deployer, /network_args\+=\(--html-preview-root "\$PREVIEW_ROOT"\)/);
  assert.match(deployer, /systemctl enable ubot\.target ubot-maintenance\.timer ubot-cloudflare-allowlist\.timer/);
  assert.match(deployer, /systemctl start ubot-cloudflare-allowlist\.timer/);

  const networkConfiguration = deployer.lastIndexOf('"$NODE_BIN" "$STAGING_DIR/scripts/configure-v3-network.mjs"');
  const identityMigration = deployer.lastIndexOf("migrate_runtime_identity_after_backup\n");
  const serviceStart = deployer.lastIndexOf("sudo systemctl start ubot.target");
  const ingressListener = deployer.indexOf("wait_for_ingress_read_api_listener\n", serviceStart);
  const napcatRestart = deployer.indexOf("restart_napcat_container\n", serviceStart);
  const ingressHealth = deployer.indexOf("wait_for_ingress_read_api_health\n", napcatRestart);
  const adminBoundary = deployer.lastIndexOf("wait_for_admin_auth_boundary\n");
  assert.ok(networkConfiguration >= 0 && identityMigration > networkConfiguration, "runtime ownership changes must follow configured persistent state");
  assert.ok(identityMigration < serviceStart, "runtime ownership must be established before services start");
  assert.ok(ingressListener > serviceStart, "Ingress listener liveness must run after services start");
  assert.ok(napcatRestart > ingressListener, "NapCat must restart only after the new Ingress listener is reachable");
  assert.ok(ingressHealth > napcatRestart && adminBoundary > napcatRestart, "connected health probes must run after NapCat restarts");
});

test("V3 deployer fixes root-controlled paths before unpacking and enabling Cloudflare updates", () => {
  assert.match(deployer, /APP_ROOT="\/opt\/ai-project"/);
  assert.match(deployer, /RELEASE_ROOT="\/opt\/ai-project-releases"/);
  assert.match(deployer, /NODE_RUNTIME_ROOT="\/opt\/ubot-runtime"/);
  assert.match(deployer, /UBOT_APP_ROOT:-\}" && "\$UBOT_APP_ROOT" != "\$APP_ROOT"/);
  assert.match(deployer, /UBOT_RELEASE_ROOT:-\}" && "\$UBOT_RELEASE_ROOT" != "\$RELEASE_ROOT"/);
  assert.match(deployer, /UBOT_NODE_RUNTIME_ROOT:-\}" && "\$UBOT_NODE_RUNTIME_ROOT" != "\$NODE_RUNTIME_ROOT"/);
  assert.match(deployer, /root paths are fixed in the hardened production topology/);
  assert.match(deployer, /lock_root_controlled_directory "\$APP_ROOT" "Application root" "false"/);
  assert.match(deployer, /lock_root_controlled_directory "\$RELEASE_ROOT" "Release root" "true"/);
  assert.match(deployer, /lock_root_controlled_directory "\$NODE_RUNTIME_ROOT" "Node runtime root" "false"/);
  assert.match(deployer, /chown root:root "\$target"/);
  assert.match(deployer, /chmod 0755 "\$target"/);
  assert.match(deployer, /metadata="\$\(stat -c '%u:%g:%a' "\$target"\)"/);
  assert.match(deployer, /BACKUP_DIR="\$\(mktemp -d "\$BACKUP_ROOT\/\$\{TIMESTAMP\}-v\$\{VERSION\}\.XXXXXX"\)"/);
  assert.match(deployer, /STAGING_DIR="\$\(mktemp -d "\$RELEASE_ROOT\/\.staging-v\$\{VERSION\}\.XXXXXX"\)"/);

  const rootHardening = deployer.lastIndexOf("ensure_root_controlled_deployment_roots\n");
  const releaseInputStage = deployer.lastIndexOf("stage_release_inputs\n");
  const checksumVerification = deployer.lastIndexOf("verify_checksum\n");
  const releaseBundlePreflight = deployer.lastIndexOf("prepare_release_bundle_preflight\n");
  const cloudflareTimerEnable = deployer.lastIndexOf("sudo systemctl enable ubot.target ubot-maintenance.timer ubot-cloudflare-allowlist.timer");
  assert.match(deployer, /Release archive must be a regular file, not a symbolic link/);
  assert.match(deployer, /SYSTEM_PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/);
  assert.match(deployer, /unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS/);
  assert.match(releaseArchiveValidator, /unsupported tar entry type/);
  assert.match(releaseArchiveValidator, /duplicate path/);
  assert.match(releaseArchiveValidator, /unsafe path/);
  assert.match(releaseArchiveValidator, /unsafe file permissions/);
  assert.match(releaseZipValidator, /duplicate path/);
  assert.match(releaseZipValidator, /symbolic link or unsupported file type/);
  assert.match(releaseZipValidator, /uncompressed size limit/);
  assert.match(deployer, /chmod u-s,g-s/);
  assert.match(deployer, /Hardened release tree still contains SUID or SGID permissions/);
  assert.ok(deployer.includes('tar --extract --gzip --file="$BUNDLE" --directory="$STAGING_DIR"'), "release bundle preflight must unpack into the secured release root");
  assert.ok(releaseInputStage > rootHardening && checksumVerification > releaseInputStage, "the root-owned archive snapshot must be created before verification");
  assert.ok(rootHardening >= 0 && releaseBundlePreflight > rootHardening, "root-controlled paths must be secured before extracting a release");
  assert.ok(rootHardening < cloudflareTimerEnable, "root-controlled paths must be secured before enabling the Cloudflare updater");
});

test("Node runtime reuse validates root, payload, and active link before activation", () => {
  assert.match(nodeRuntimeInstaller, /assert_root_owned_directory "\/opt" "Runtime ancestor"/);
  assert.match(nodeRuntimeInstaller, /assert_root_owned_directory "\$current" "Node runtime path component"/);
  assert.match(nodeRuntimeInstaller, /assert_runtime_payload\(\)/);
  assert.match(nodeRuntimeInstaller, /if \[\[ -e "\$target_dir" \|\| -L "\$target_dir" \]\]; then\s+assert_runtime_payload/s);
  assert.match(nodeRuntimeInstaller, /Existing Node runtime does not match requested version/);
  assert.match(nodeRuntimeInstaller, /if \[\[ ! -L "\$node_link" \|\| "\$\(readlink "\$node_link"\)" != "node-v\$VERSION" \]\]; then/);
  assert.match(nodeRuntimeInstaller, /Refusing unexpected Node 22 link/);
  assert.match(nodeRuntimeInstaller, /activate_node22_link/);
});

test("V3 deployer validates and hardens the BT dependency runtime before UBot starts", () => {
  assert.match(deployer, /BT_RUNTIME_ROOT="\$APP_ROOT\/bt-runtime"/);
  assert.match(deployer, /BT_STATE_ROOT="\$PERSISTENT_DATA\/bt"/);
  assert.match(deployer, /validate_bt_runtime_links\(\)/);
  assert.match(deployer, /BT runtime link escapes the controlled runtime or \/usr/);
  assert.match(deployer, /BT runtime must not contain device, FIFO, or socket entries/);
  assert.match(deployer, /chown -hR root:root -- "\$BT_RUNTIME_ROOT"/);
  assert.match(deployer, /chmod a\+rX,go-w,u-s,g-s/);
  assert.match(deployer, /BT runtime tree contains non-root-controlled or unsafe content/);
  assert.match(deployer, /-perm \/022 -o -perm \/6000/);
  assert.match(deployer, /prepare_bt_state_directory\(\)/);
  assert.match(deployer, /chown "\$RUNTIME_USER:\$RUNTIME_GROUP" "\$BT_STATE_ROOT"/);
  assert.match(deployer, /UBot runtime account cannot write its BT state directory/);

  const btRuntimeHardening = deployer.lastIndexOf("harden_bt_runtime\n");
  const statePreparation = deployer.lastIndexOf("prepare_bt_state_directory\n");
  const serviceStart = deployer.lastIndexOf("sudo systemctl start ubot.target");
  assert.ok(btRuntimeHardening >= 0 && btRuntimeHardening < serviceStart, "BT dependency code must be immutable before UBot starts");
  assert.ok(statePreparation >= 0 && statePreparation < serviceStart, "BT writable state must be prepared under data before UBot starts");
  assert.doesNotMatch(workerUnit, /ReadWritePaths=.*bt-runtime/);
});

test("root deployment and Cloudflare helpers refuse mutable bootstrap sources", () => {
  assert.match(deployer, /DEPLOY_SCRIPT_PATH="\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  assert.match(deployer, /assert_root_controlled_source_tree "\$DEPLOY_SCRIPT_DIR" "Deployment helper source"/);
  assert.match(deployer, /must be owned by root:root/);
  assert.match(deployer, /must not be writable by group or other users/);
  assert.match(deployer, /must not contain symbolic links/);
  assert.match(deployer, /Do not bootstrap a root deployment from an old, mutable `current` release/);
  assert.match(cloudflareOriginInstaller, /SCRIPT_PATH="\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  assert.match(cloudflareOriginInstaller, /assert_root_controlled_source_tree "\$ROOT\/scripts" "Origin hardening helper source"/);
  assert.match(cloudflareOriginInstaller, /assert_root_controlled_source_tree "\$ROOT\/deploy\/nginx" "Origin hardening template source"/);
  assert.match(cloudflareOriginInstaller, /must never bootstrap from an old mutable `current` release/);
  assert.match(cloudflareAllowlistUpdater, /SCRIPT_PATH="\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  assert.match(cloudflareAllowlistUpdater, /assert_root_controlled_source_tree "\$SCRIPT_DIR" "Cloudflare allow-list updater source"/);
  assert.match(cloudflareAllowlistUpdater, /must be owned by root:root/);
  assert.match(cloudflareAllowlistUpdater, /must not be writable by group or other users/);
  assert.match(cloudflareAllowlistUpdater, /must not contain symbolic links/);
  assert.match(nodeRuntimeInstaller, /SCRIPT_PATH="\$\(readlink -f -- "\$\{BASH_SOURCE\[0\]\}"\)"/);
  assert.match(nodeRuntimeInstaller, /assert_root_controlled_source_tree "\$INSTALLER_SCRIPT_DIR" "Node runtime installer source"/);
  assert.match(nodeRuntimeInstaller, /Node runtime installer bootstrap safety check failed/);
  assert.match(nodeRuntimeInstaller, /must be owned by root:root/);
  assert.match(nodeRuntimeInstaller, /must not be writable by group or other users/);
  assert.match(nodeRuntimeInstaller, /must not contain symbolic links/);
  assert.match(nodeRuntimeInstaller, /TMPDIR="\/tmp"/);
  assert.match(nodeRuntimeInstaller, /unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS/);
  assert.match(cloudflareAllowlistUpdater, /TMPDIR="\/tmp"/);
  assert.match(cloudflareAllowlistUpdater, /unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH TAR_OPTIONS/);

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
    assert.match(unit, /User=ubot/);
    assert.match(unit, /Group=ubot/);
    assert.match(unit, /WorkingDirectory=\/opt\/ai-project-releases\/current/);
    assert.match(unit, /EnvironmentFile=\/opt\/ai-project\/\.env/);
    assert.match(unit, /ExecStart=\/opt\/ubot-runtime\/node22\/bin\/node dist\/index\.js/);
    assert.match(unit, /Environment=PATH=\/opt\/ubot-runtime\/node22\/bin:\/usr\/bin:\/bin/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /PrivateTmp=true/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /ReadWritePaths=\/opt\/ai-project\/data \/var\/lib\/ubot-preview/);
  }
  assert.match(ingressUnit, /BOT_ROLE=ingress/);
  assert.match(workerUnit, /BOT_ROLE=worker/);
  assert.match(adminUnit, /BOT_ROLE=admin/);
  assert.match(targetUnit, /Wants=ubot-ingress\.service ubot-worker\.service ubot-admin\.service/);
  assert.match(maintenanceUnit, /Environment=UBOT_APP_ROOT=\/opt\/ai-project/);
  assert.match(maintenanceUnit, /User=ubot/);
  assert.match(maintenanceUnit, /ExecStart=\/opt\/ubot-runtime\/node22\/bin\/node/);
  assert.match(maintenanceUnit, /migrate-v3-state\.mjs --maintenance --execute/);
  assert.match(maintenanceTimer, /Description=Run UBot V3 retention maintenance hourly/);
  assert.match(maintenanceTimer, /OnCalendar=\*-\*-\* \*:17:00 UTC/);
  assert.match(networkConfigurator, /172\.21\.0\.1:6199/);
  assert.match(networkConfigurator, /approvedNapcatUrlPath/);
  assert.match(networkConfigurator, /network\.websocketClients\.0\.url/);
  assert.match(networkConfigurator, /writeAtomic/);
  assert.match(networkConfigurator, /writePairedAtomically/);
  assert.match(networkConfigurator, /original NapCat configuration was restored/);
});

test("V3 release source verification restricts artifacts to the audited runtime allow-list", () => {
  const verifier = readFileSync(path.resolve("scripts", "verify-release-source.mjs"), "utf8");
  const linuxPackager = readFileSync(path.resolve("scripts", "package-linux-release.sh"), "utf8");
  const windowsPackager = readFileSync(path.resolve("scripts", "package-win.ps1"), "utf8");
  const bashRunner = readFileSync(path.resolve("scripts", "run-bash.cjs"), "utf8");
  const packageManifest = readFileSync(path.resolve("package.json"), "utf8");

  assert.match(verifier, /approvedStaticFiles/);
  assert.match(verifier, /not an approved release path/);
  assert.match(verifier, /\.sqlite-wal/);
  assert.match(verifier, /loadPrivateEnterpriseRanking/);
  assert.match(verifier, /headquartersResearchStatus/);
  assert.match(verifier, /headquartersEvidenceArchiveSha256/);
  assert.match(verifier, /readHeadquartersReviewVerification/);
  assert.match(verifier, /--headquarters-review-env/);
  assert.match(verifier, /In-progress headquarters research must not enable city statistics/);
  assert.match(verifier, /Complete headquarters research must enable 500-city coverage/);
  assert.match(packageManifest, /"package:linux": "node scripts\/run-node22\.cjs scripts\/run-bash\.cjs scripts\/package-linux-release\.sh"/);
  assert.match(bashRunner, /run-bash must run on Node\.js/);
  assert.match(bashRunner, /UBOT_NODE_BIN: nodeBinary/);
  assert.match(bashRunner, /UBOT_NPM_CLI: npmCli/);
  assert.match(linuxPackager, /NODE_BIN="\$\{UBOT_NODE_BIN:-\}"/);
  assert.match(linuxPackager, /NPM_CLI="\$\{UBOT_NPM_CLI:-\}"/);
  assert.match(linuxPackager, /Linux release packaging requires Node\.js 22 or newer/);
  assert.match(linuxPackager, /run_npm ci --omit=dev --ignore-scripts/);
  assert.doesNotMatch(linuxPackager, /\nnpm ci --omit=dev --ignore-scripts/);
  assert.match(windowsPackager, /Resolve-UbotNodeRuntime/);
  assert.match(windowsPackager, /Node\.js 22 or newer with its paired npm CLI is required/);
  assert.match(windowsPackager, /\$env:UBOT_NODE = \$nodeBinary/);
  assert.match(windowsPackager, /Invoke-UbotNpm "run" "build"/);
  assert.match(windowsPackager, /Invoke-UbotNode "\$projectRoot\/scripts\/bt-release-files\.cjs"/);
  assert.match(windowsPackager, /Invoke-UbotNode "scripts\/verify-release-source\.mjs"/);
  assert.match(windowsPackager, /Invoke-UbotNode "scripts\/secret-scan\.mjs" "--source"/);
  assert.match(windowsPackager, /Invoke-UbotNpm "ci" "--omit=dev" "--ignore-scripts"/);
  assert.doesNotMatch(windowsPackager, /\nnpm ci --omit=dev --ignore-scripts/);
  assert.match(windowsPackager, /set "NODE_ENV=production"/);
  for (const asset of ["assets/huixian-profile.json", "assets/blacklisted-at-meme.jpg"]) {
    const pathPattern = new RegExp(asset.replaceAll(".", "\\."));
    assert.match(verifier, pathPattern);
    assert.match(linuxPackager, pathPattern);
    assert.match(windowsPackager, pathPattern);
  }
  for (const asset of [
    "assets/private-enterprises-2026-headquarters.json",
    "assets/private-enterprises-2026-headquarters-evidence.json",
    "assets/private-enterprises-2026-headquarters-review.md",
  ]) {
    const pathPattern = new RegExp(asset.replaceAll(".", "\\."));
    assert.match(verifier, pathPattern);
    assert.match(linuxPackager, pathPattern);
    assert.match(windowsPackager, pathPattern);
    assert.match(deployer, pathPattern);
  }
  // v3.0.46 consolidates public release material into the top-level handbook.
  // Keep the security release checks aligned with that public-document model.
  for (const source of [verifier, linuxPackager, windowsPackager]) {
    assert.match(source, /README\.md/);
    assert.match(source, /public-docs\.mjs/);
  }
  for (const releaseFile of [
    "scripts/rotate-gemini-reply-key.mjs",
    "scripts/install-node22-runtime.sh",
    "scripts/update-cloudflare-origin-allowlist.sh",
    "scripts/install-cloudflare-origin-hardening.sh",
    "scripts/verify-nginx-vhost-ownership.mjs",
    "scripts/validate-release-archive.mjs",
    "deploy/systemd/ubot-cloudflare-allowlist.service.template",
    "deploy/systemd/ubot-cloudflare-allowlist.timer.template",
  ]) {
    const pathPattern = new RegExp(releaseFile.replaceAll(".", "\\."));
    assert.match(verifier, pathPattern);
    assert.match(linuxPackager, pathPattern);
    assert.match(windowsPackager, pathPattern);
  }
  assert.match(linuxPackager, /secret-scan\.mjs --source "\$VERIFY_DIR"/);
  assert.match(windowsPackager, /Invoke-UbotNode "scripts\/secret-scan\.mjs" "--source" \$verifyDir/);
  assert.match(windowsPackager, /Invoke-UbotNode "scripts\/validate-release-zip\.mjs" \$zipPath/);
  assert.match(windowsPackager, /Invoke-UbotNode "scripts\/create-release-zip\.mjs" \$bundleDir \$zipPath/);
  for (const source of [verifier, linuxPackager, windowsPackager]) {
    assert.doesNotMatch(source, /set-gemini-key-and-model\.mjs/);
  }
});

test("Windows packager selects one compatible Node runtime when PATH has multiple installations", () => {
  const windowsPackager = readFileSync(path.resolve("scripts", "package-win.ps1"), "utf8");
  assert.match(windowsPackager, /Get-Command "node" -CommandType Application -All -ErrorAction SilentlyContinue/);
  assert.match(windowsPackager, /foreach \(\$pathCommand in \$pathCommands\)/);
  assert.match(windowsPackager, /Get-UbotNodeRuntime \(\[string\]\$pathCommand\.Path\)/);
  assert.match(windowsPackager, /\$versionLines = @\(& \$NodePath --version 2>\$null\)/);
  assert.match(windowsPackager, /\$nodeExitCode = \$LASTEXITCODE/);
});

test("formal release publication is gated to the matching final tag and CI", () => {
  assert.match(releaseWorkflow, /UBOT_RELEASE_PIPELINE_ENABLED: \$\{\{ vars\.UBOT_RELEASE_PIPELINE_ENABLED \}\}/);
  assert.match(releaseWorkflow, /secret-scan:[\s\S]*?if: vars\.UBOT_RELEASE_PIPELINE_ENABLED == 'true'/);
  assert.match(releaseWorkflow, /package-windows:[\s\S]*?if: vars\.UBOT_RELEASE_PIPELINE_ENABLED == 'true'/);
  assert.match(releaseWorkflow, /package-linux:[\s\S]*?if: vars\.UBOT_RELEASE_PIPELINE_ENABLED == 'true'/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*?if: vars\.UBOT_RELEASE_PIPELINE_ENABLED == 'true'/);
  assert.match(releaseWorkflow, /needs: \[package-windows, package-linux\]/);
  assert.match(releaseWorkflow, /!contains\(github\.ref_name, '-'\)/);
  assert.match(releaseWorkflow, /permissions:\s+contents: read/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*?permissions:\s+contents: write/);
  assert.match(releaseWorkflow, /release-artifact-review:[\s\S]*?validate-release-archive\.mjs/);
  assert.match(releaseWorkflow, /release-artifact-review:[\s\S]*?validate-release-zip\.mjs/);
  assert.match(releaseWorkflow, /release-artifact-review:[\s\S]*?--no-same-owner --no-same-permissions --delay-directory-restore/);
  assert.match(releaseWorkflow, /release-artifact-review:[\s\S]*?name: reviewed-release-assets/);
  assert.match(releaseWorkflow, /release-metadata:[\s\S]*?name: reviewed-release-notes/);
  assert.match(releaseWorkflow, /github-release:[\s\S]*?name: reviewed-release-assets/);
  assert.doesNotMatch(releaseWorkflow.match(/github-release:[\s\S]*/)?.[0] ?? "", /node scripts\/|tar --extract|unzip -q/);
  assert.match(releaseWorkflow, /softprops\/action-gh-release@[a-f0-9]{40}[\s\S]*?token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(releaseWorkflow, /matching v\$VERSION tag/);
  assert.match(releaseWorkflow, /verify-release-assets\.mjs/);
  assert.match(releaseWorkflow, /vars\.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY/);
  assert.match(ciWorkflow, /vars\.UBOT_PRIVATE_ENTERPRISE_HEADQUARTERS_REVIEW_PUBLIC_KEY/);
  assert.doesNotMatch(readFileSync(path.resolve("package.json"), "utf8"), /release:github/);
});

test("continuous integration validates the complete suite on Windows and Linux", () => {
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /ubuntu-latest/);
  assert.match(ciWorkflow, /windows-latest/);
  assert.match(ciWorkflow, /node-version: "22"/);
  assert.match(ciWorkflow, /npm ci/);
  assert.match(ciWorkflow, /npm run audit:prod/);
  assert.match(ciWorkflow, /npm run verify/);
  assert.match(ciWorkflow, /npx --no-install playwright install --with-deps chromium/);
  assert.match(ciWorkflow, /npm run smoke:admin/);
  assert.match(ciWorkflow, /admin-visual-smoke/);
  assert.match(ciWorkflow, /gitleaks\/gitleaks-action@[a-f0-9]{40}/);
  assert.match(ciWorkflow, /GITLEAKS_CONFIG: \.gitleaks\.toml/);
  assert.match(ciWorkflow, /actions\/checkout@[a-f0-9]{40}/);
  assert.match(ciWorkflow, /actions\/setup-node@[a-f0-9]{40}/);
  assert.match(releaseWorkflow, /actions\/setup-go@[a-f0-9]{40}/);
  assert.match(releaseWorkflow, /gitleaks\/v8@v8\.24\.3/);
  assert.match(releaseWorkflow, /GITLEAKS_BIN/);
  assert.match(releaseWorkflow, /npm run audit:prod/);
  assert.match(releaseWorkflow, /npx --no-install playwright install --with-deps chromium/);
  assert.match(releaseWorkflow, /npm run smoke:admin/);
  assert.match(releaseWorkflow, /needs: \[verify, secret-scan, admin-visual-smoke\]/);
  assert.match(releaseWorkflow, /Scan exact release payloads/);
  assert.match(releaseWorkflow, /secret-scan\.mjs --source release-scan/);
});

test("V3 Nginx requires a strict Cloudflare origin boundary and trusted real IP", () => {
  assert.match(nginx, /include \/etc\/nginx\/ubot-cloudflare-realip\.conf/);
  assert.match(nginx, /if \(\$ubot_cloudflare_origin_allowed = 0\) \{/);
  assert.match(nginx, /return 403/);
  assert.match(nginx, /ssl_certificate __UBOT_BOT_CERT_PATH__;/);
  assert.match(nginx, /ssl_protocols TLSv1\.2 TLSv1\.3/);
  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:6200/);
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto https/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Port 443/);
  assert.doesNotMatch(nginx, /Flexible|\$http_cf_visitor/);
  assert.doesNotMatch(nginx, /\$http_x_forwarded_proto/);
  assert.match(nginx, /Content-Security-Policy/);
  assert.equal((nginx.match(/location ~ \^\/\(\?:\\\.env/g) ?? []).length, 1);
  assert.doesNotMatch(nginx, /assets\(\?:\/\|\$\)/);
  assert.match(cloudflareAllowlistUpdater, /https:\/\/www\.cloudflare\.com\/ips-v4/);
  assert.match(cloudflareAllowlistUpdater, /https:\/\/www\.cloudflare\.com\/ips-v6/);
  assert.match(cloudflareAllowlistUpdater, /validate_list "\$TEMPORARY_DIR\/ips-v4" v4 10/);
  assert.match(cloudflareAllowlistUpdater, /validate_list "\$TEMPORARY_DIR\/ips-v6" v6 5/);
  assert.match(cloudflareAllowlistUpdater, /geo \\\$realip_remote_addr \\\$ubot_cloudflare_origin_allowed/);
  assert.match(cloudflareAllowlistUpdater, /real_ip_header CF-Connecting-IP/);
  assert.match(cloudflareAllowlistUpdater, /NGINX_BIN="\/usr\/sbin\/nginx"/);
  assert.match(cloudflareAllowlistUpdater, /NODE_BIN="\/opt\/ubot-runtime\/node22\/bin\/node"/);
  assert.match(cloudflareAllowlistUpdater, /if ! "\$NGINX_BIN" -t; then/);
  assert.match(cloudflareAllowlistUpdater, /replace_file_atomically\(\)/);
  assert.match(cloudflareAllowlistUpdater, /Refusing Nginx target that is not a regular file/);
  assert.match(cloudflareAllowlistUpdater, /restore_previous_configuration\(\)/);
  assert.match(cloudflareAllowlistUpdater, /Nginx reload failed after refreshing Cloudflare allow-lists; previous files were restored/);
  assert.match(cloudflareAllowlistUnit, /ProtectSystem=strict/);
  assert.match(cloudflareAllowlistUnit, /ReadWritePaths=\/etc\/nginx \/run\/nginx\.pid \/var\/log\/nginx\/access\.log \/var\/log\/nginx\/error\.log/);
  assert.match(cloudflareOriginInstaller, /UBOT_CLOUDFLARE_STRICT_READY/);
  assert.match(cloudflareOriginInstaller, /all proxied 9958\.uk origins pass preflight on Full \(strict\)/);
  assert.match(cloudflareOriginInstaller, /PREVIEW_TEMPLATE=/);
  assert.match(cloudflareOriginInstaller, /NODE_BIN="\/opt\/ubot-runtime\/node22\/bin\/node"/);
  assert.match(cloudflareOriginInstaller, /Required application-scoped Node 22 runtime is missing or not executable/);
  assert.match(cloudflareOriginInstaller, /"\$NODE_BIN" - "\$APP_ROOT\/\.env" "\$APP_ROOT"/);
  assert.match(cloudflareOriginInstaller, /preview\.9958\.uk\.pem/);
  assert.match(cloudflareOriginInstaller, /preview\.9958\.uk\.key/);
  assert.match(cloudflareOriginInstaller, /UBOT_CLOUDFLARE_ORIGIN_BOUNDARY=1/);
  assert.match(cloudflareOriginInstaller, /both UBot vhosts were restored/);
  assert.match(cloudflareOriginInstaller, /Cloudflare Origin certificate or private key is missing/);
  assert.match(cloudflareOriginInstaller, /certificate file must not be writable by group or other users/);
  assert.match(cloudflareOriginInstaller, /-checkend "\$minimum_validity_seconds"/);
  assert.match(cloudflareOriginInstaller, /expired or expires within seven days/);
  assert.match(cloudflareOriginInstaller, /grep -oE 'DNS:\[\^,\[:space:\]\]\+'/);
  assert.match(cloudflareOriginInstaller, /grep -Fqx -e "\$hostname" -e '\*\.9958\.uk'/);
  assert.doesNotMatch(cloudflareOriginInstaller, /\*"DNS:\$hostname"\*/);
  assert.match(cloudflareOriginInstaller, /PATH="\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/);
  assert.match(deployer, /\$label Origin certificate file must not be writable by group or other users/);
  assert.match(deployer, /-checkend "\$minimum_validity_seconds"/);
  assert.match(deployer, /\$label Origin certificate is expired or expires within seven days/);
  assert.match(deployer, /grep -oE 'DNS:\[\^,\[:space:\]\]\+'/);
  assert.match(deployer, /grep -Fqx -e "\$hostname" -e '\*\.9958\.uk'/);
  assert.doesNotMatch(deployer, /\*"DNS:\$hostname"\*/);
  assert.match(deployer, /origin_cidrs" -lt 15/);
  assert.match(deployer, /origin_cidrs" != "\$realip_cidrs"/);
  assert.match(deployer, /BOT_NGINX_CONFIG="\/etc\/nginx\/sites-available\/bot-9958"/);
  assert.match(deployer, /BOT_NGINX_ENABLED_LINK="\/etc\/nginx\/sites-enabled\/bot-9958"/);
  assert.match(deployer, /preflight_cloudflare_vhost\(\)/);
  assert.match(deployer, /verify_effective_nginx_vhost_ownership\(\)/);
  assert.match(deployer, /verify-nginx-vhost-ownership\.mjs/);
  assert.doesNotMatch(deployer, /NGINX_RENDERED_CONFIG/);
  assert.match(deployer, /must apply the Cloudflare real-IP include and origin gate on both HTTP and HTTPS listeners/);
});

test("HTML preview Nginx rewrites directory URLs to one explicit index file", () => {
  assert.match(previewNginx, /rewrite "\^\/p\/\(\[A-Za-z0-9_-\]\{43\}\)\/\$" \/p\/\$1\/index\.html last;/);
  assert.ok(previewNginx.includes('location ~ "^/p/([A-Za-z0-9_-]{43})/index\\\\.html$"'));
  assert.doesNotMatch(previewNginx, /location ~ "\^\/p\/\(\[A-Za-z0-9_-\]\{43\}\)\/\$" \{\s*alias/s);
});

test("HTML preview content remains offline and capability-isolated by browser policy", () => {
  assert.match(previewNginx, /default-src 'none'/);
  assert.match(previewNginx, /base-uri 'none'/);
  assert.match(previewNginx, /form-action 'none'/);
  assert.match(previewNginx, /object-src 'none'/);
  assert.match(previewNginx, /connect-src 'none'/);
  assert.match(previewNginx, /script-src 'unsafe-inline'/);
  assert.match(previewNginx, /style-src 'unsafe-inline'/);
  assert.match(previewNginx, /worker-src 'none'/);
  assert.match(previewNginx, /frame-src 'none'/);
  assert.match(previewNginx, /sandbox allow-scripts/);
});
