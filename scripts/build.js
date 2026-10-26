/* Builds the portable Windows app and ZIP:  npm run build
   Output: dist/Santa Rosa Tile Scheduler/  and  dist/Santa-Rosa-Tile-Scheduler-win64.zip
   If google-client.json exists in the project root it is copied beside the .exe so managers do not have to paste anything. */
const { packager } = require('@electron/packager');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const NAME = 'Santa Rosa Tile Scheduler';

(async () => {
  const dist = path.join(root, 'dist');
  fs.rmSync(dist, { recursive: true, force: true }); fs.mkdirSync(dist);
  const [out] = await packager({
    dir: root, out: dist, name: NAME, executableName: NAME, platform: 'win32', arch: 'x64', overwrite: true, asar: true, prune: false,
    icon: path.join(root, 'build', 'icon.ico'), appVersion: pkg.version,
    ignore: [/^\/(dist|test|scripts|docs|build|node_modules|package-lock\.json|google-client\.json|\.git|\.gitignore|publish-update\.bat)(\/|$)/, /\.md$/],
    win32metadata: { CompanyName: 'Santa Rosa Tile Supply', FileDescription: NAME, ProductName: NAME, OriginalFilename: NAME + '.exe' },
    quiet: true,
  });
  const final = path.join(dist, NAME);
  fs.renameSync(out, final);
  for (const f of ['README-FIRST.txt', 'USER-GUIDE.txt', 'GOOGLE-SETUP.txt', 'UPDATING.txt']) fs.copyFileSync(path.join(root, 'docs', f), path.join(final, f));
  const gc = path.join(root, 'google-client.json');
  if (process.env.SRTS_NO_CLIENT) console.log('Public build: google-client.json NOT included.');
  else if (fs.existsSync(gc)) { fs.copyFileSync(gc, path.join(final, 'google-client.json')); console.log('Included google-client.json'); }
  else console.log('NOTE: no google-client.json in project root; managers will need to paste the Client ID (see GOOGLE-SETUP.txt).');
  const zip = path.join(dist, 'Santa-Rosa-Tile-Scheduler-win64.zip');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', dist, NAME], { stdio: 'inherit' });
  console.log(`\nBuilt: ${final}\nZIP:   ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(0)} MB)`);
})().catch(e => { console.error(e); process.exit(1); });
