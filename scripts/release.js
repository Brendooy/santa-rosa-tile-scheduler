/* Publish a new version:   node scripts/release.js [patch|minor|major|x.y.z] ["release notes"]
   (or double-click publish-update.bat)
   Bumps the version, runs the tests, builds a PUBLIC package (without google-client.json), commits, tags and pushes,
   then creates a GitHub Release holding the ZIP plus app.asar and update.json, which installed copies use to update themselves. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const die = m => { console.error('\nSTOPPED: ' + m); process.exit(1); };

const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const bump = process.argv[2] || 'patch', notes = process.argv[3] || '';
let [a, b, c] = pkg.version.split('.').map(Number);
const next = /^\d+\.\d+\.\d+$/.test(bump) ? bump : bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
const tag = 'v' + next;

try { out('gh', ['auth', 'status']); } catch (_) { die('GitHub is not signed in. Run: gh auth login'); }
if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root }).status !== 0) die('This folder is not a git repository.');
if (out('git', ['tag', '--list', tag])) die(`${tag} already exists. Pick a different version.`);

console.log(`Releasing ${pkg.version} -> ${next}\n`);
run(process.execPath, ['test/logic.test.js'], { stdio: ['ignore', 'ignore', 'inherit'] });

// version bump
for (const f of ['package.json', 'package-lock.json']) {
  const p = path.join(root, f); if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.version = next; if (j.packages && j.packages['']) j.packages[''].version = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}

// public build: never contains the Google client secret
run(process.execPath, ['scripts/build.js'], { env: { ...process.env, SRTS_NO_CLIENT: '1' } });
const dist = path.join(root, 'dist');
const asar = path.join(dist, 'Santa Rosa Tile Scheduler', 'resources', 'app.asar');
const zip = path.join(dist, 'Santa-Rosa-Tile-Scheduler-win64.zip');
const buf = fs.readFileSync(asar);
const electron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const meta = path.join(dist, 'update.json');
// Sign the update so installed copies only accept releases made by this computer's private key (not stored on GitHub).
const keyFile = path.join(require('os').homedir(), '.srts-update-signing-key.pem');
if (!fs.existsSync(keyFile)) die(`Signing key not found: ${keyFile}. Without it installed copies would reject the update.`);
const info = { version: next, electron, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
info.sig = crypto.sign(null, Buffer.from(['srts-update', info.version, info.electron, info.sha256, info.size].join('\n')), crypto.createPrivateKey(fs.readFileSync(keyFile))).toString('base64');   // keep identical to src/updater.js
fs.writeFileSync(meta, JSON.stringify(info, null, 1));

// commit + tag + push, then the release
run('git', ['add', '-A']);
spawnSync('git', ['commit', '-m', `Release ${tag}${notes ? ': ' + notes : ''}`], { cwd: root, stdio: 'inherit' });
run('git', ['tag', tag]);
run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', tag]);
run('gh', ['release', 'create', tag, zip, asar, meta, '--title', `Santa Rosa Tile Scheduler ${next}`, '--notes', notes || `Version ${next}`]);
console.log(`\nPublished ${tag}. Copies of the app will offer this update the next time they start (or when "Check for updates" is clicked).`);
console.log('Note: the release ZIP does not contain google-client.json. For a fresh computer, copy that file beside the .exe once.');
