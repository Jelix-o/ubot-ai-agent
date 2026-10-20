// Shared explicit allow-list: runtime files only, no fixtures or mutable state.
module.exports = Object.freeze([
  "scripts/bt-release-files.cjs",
  "scripts/bt-capability-policy.mjs",
  "scripts/install-bt-deps.mjs",
  "assets/bt/package.json",
  "assets/bt/requirements.txt",
  "assets/bt/scripts/bt.js",
  "assets/bt/scripts/curl_cffi_fetch.py",
  "assets/bt/scripts/curl_cffi_worker.py",
  ...["html-utils", "media-utils", "query-utils", "renderers", "runtime", "site-common", "site-registry", "tracker-site"].map(name => `assets/bt/scripts/lib/${name}.js`),
  ...["mikan", "nyaa", "btbtla", "onelou", "kpkuang", "sukebei"].map(name => `assets/bt/scripts/sources/${name}.js`),
]);
if (require.main === module) console.log(module.exports.join("\n"));
