import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    executableName: 'BackupHub',
    // better-sqlite3 is externalized from the Vite bundle (vite.main.config.ts), so it must ship as
    // real files in the packaged app's node_modules, and its .node binary must live outside the
    // asar archive or dlopen cannot load it.
    // The Vite plugin's default `ignore` keeps ONLY `.vite`; overriding it (the plugin applies its
    // default only when this is unset) also keeps node_modules and package.json. Forge's own
    // pruning still strips devDependencies. electron-squirrel-startup stays bundled by Vite.
    ignore: (file: string) => {
      if (!file) return false;
      if (file.startsWith('/.vite')) return false;
      if (file.startsWith('/node_modules')) {
        // Trim what better-sqlite3 never needs at runtime on this machine: C++/SQLite sources and
        // prebuilt binaries for other platforms (win32-x64.node is the one that loads).
        if (/^\/node_modules\/better-sqlite3\/(deps|src)(\/|$)/.test(file)) return true;
        if (/^\/node_modules\/better-sqlite3\/prebuilds\/(?!win32-x64\.node$)/.test(file)) return true;
        return false;
      }
      if (file === '/package.json') return false;
      return true;
    },
    asar: {
      unpack: '**/*.node',
    },
  },
  // better-sqlite3 13 ships N-API prebuilt binaries that load in both Node and Electron, so nothing
  // needs compiling (this PC has no C++ build tools). An empty list stops Forge's electron-rebuild
  // step from trying to node-gyp it anyway.
  rebuildConfig: { onlyModules: [] },
  makers: [new MakerSquirrel({}), new MakerZIP({})],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        // The hashing worker thread is its own file next to main.js (appServices loads it by that name).
        { entry: 'src/main/hashing/hashWorker.ts', config: 'vite.main.config.ts', target: 'main' },
        // The checksum worker thread (the SHA-256 of a copy's blocks, off the window's thread; main.ts gives its path to blockDigest.ts).
        { entry: 'src/main/hashing/digestWorker.ts', config: 'vite.main.config.ts', target: 'main' },
        // The query worker thread (coverage, file stats, startup quick_check) is built the same way; it loads better-sqlite3 like main.js does.
        { entry: 'src/main/query/queryWorker.ts', config: 'vite.main.config.ts', target: 'main' },
        // The upkeep process (an Electron utilityProcess: sorts old rows, trims history, optimizes, only when the computer is idle).
        { entry: 'src/main/upkeep/upkeepProcess.ts', config: 'vite.main.config.ts', target: 'main' },
        // The quick-walk worker thread ("Look again" off the main process).
        { entry: 'src/main/listing/quickWalkWorker.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    // Fuses are flipped at package time, before signing (same set as v1).
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
