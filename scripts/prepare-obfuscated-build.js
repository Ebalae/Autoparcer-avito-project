'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const projectDirectory = path.resolve(__dirname, '..');
const electronBuilderCli = require.resolve('electron-builder/cli.js');

async function listJavaScriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function createObfuscatedBuild() {
  const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'autoparcer-obfuscated-'));
  try {
    await fs.cp(path.join(projectDirectory, 'src'), path.join(stagingDirectory, 'src'), {
      recursive: true
    });

    const packageJson = JSON.parse(
      await fs.readFile(path.join(projectDirectory, 'package.json'), 'utf8')
    );
    delete packageJson.devDependencies;
    packageJson.dependencies = {};
    packageJson.build.directories.output = path.join(
      projectDirectory,
      'release',
      `obfuscated-${packageJson.version}`
    );
    packageJson.build.electronDist = path.join(
      projectDirectory,
      'node_modules',
      'electron',
      'dist'
    );
    packageJson.build.electronVersion = JSON.parse(
      await fs.readFile(
        path.join(projectDirectory, 'node_modules', 'electron', 'package.json'),
        'utf8'
      )
    ).version;
    packageJson.build.win.icon = path.join(
      projectDirectory,
      'autoparcer-site',
      'public',
      'favicon.svg'
    );
    await fs.writeFile(
      path.join(stagingDirectory, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    await fs.mkdir(path.join(stagingDirectory, 'node_modules'));

    const sourceFiles = await listJavaScriptFiles(path.join(stagingDirectory, 'src'));
    for (const filePath of sourceFiles) {
      const source = await fs.readFile(filePath, 'utf8');
      const target = filePath.endsWith(`${path.sep}renderer.js`) ? 'browser' : 'node';
      const obfuscated = JavaScriptObfuscator.obfuscate(source, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        debugProtection: false,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        selfDefending: false,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.5,
        target,
        transformObjectKeys: false,
        unicodeEscapeSequence: false
      });
      await fs.writeFile(filePath, obfuscated.getObfuscatedCode());
      console.log(`Obfuscated ${path.relative(stagingDirectory, filePath)}`);
    }

    const result = spawnSync(process.execPath, [
      electronBuilderCli,
      '--win',
      'nsis',
      '--projectDir',
      stagingDirectory
    ], {
      cwd: projectDirectory,
      env: process.env,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`electron-builder exited with status ${result.status}.`);
    }
    console.log(`Installer created in ${packageJson.build.directories.output}`);
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

createObfuscatedBuild().catch((error) => {
  console.error('Could not create the obfuscated Windows installer.', error);
  process.exitCode = 1;
});