// Credentials exist only in memory and in the imagegen child process environment.
const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const remote = `import { DatabaseSync } from 'node:sqlite';
import { StateCipher } from '/opt/ai-project-releases/current/dist/services/v3-state-repository.js';
process.loadEnvFile('/opt/ai-project/.env');
const db = new DatabaseSync('/opt/ai-project/data/shared/bot-shared.db',{readOnly:true});
const id = 'model:gpt-image-sunburst:api_key';
const row = db.prepare('SELECT ciphertext FROM v3_system_secrets WHERE secret_key=?').get(id);
process.stdout.write(JSON.stringify({key:new StateCipher(process.env.UBOT_STATE_ENCRYPTION_KEY).decrypt(id,row.ciphertext)}));
db.close();`;
async function main() {
  const auth = JSON.parse(execFileSync('ssh', ['gcp-admin','sudo -n node --input-type=module -'], { input: remote, encoding:'utf8', windowsHide:true, stdio:['pipe','pipe','pipe'] }));
  const tunnel = spawn('ssh',['-N','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:18081:127.0.0.1:18080','gcp-admin'],{stdio:'ignore',windowsHide:true});
  try {
    await new Promise(resolve=>setTimeout(resolve,1500));
    if (tunnel.exitCode !== null) throw new Error('SSH tunnel unavailable');
    const python = path.join(process.env.USERPROFILE,'.codex','tmp','ubot-imagegen','Scripts','python.exe');
    const cli = path.join(process.env.USERPROFILE,'.codex','skills','.system','imagegen','scripts','image_gen.py');
    const child = spawn(python,[cli,'generate-batch','--input',process.argv[2] || 'output/imagegen/admin-redesign/prompts.jsonl','--out-dir','output/imagegen/admin-redesign','--concurrency','2','--max-attempts','1','--no-augment'],{env:{...process.env,OPENAI_API_KEY:auth.key,OPENAI_BASE_URL:'http://127.0.0.1:18081/v1'},stdio:'inherit',windowsHide:true});
    const code = await new Promise(resolve=>child.on('exit',resolve));
    if (code !== 0) throw new Error('Image generation failed; the configured model was not replaced');
  } finally { tunnel.kill(); }
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
