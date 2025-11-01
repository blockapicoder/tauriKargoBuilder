#!/usr/bin/env -S deno run -A
// Lit config depuis ./npm_vite_build.json, télécharge le tgz npm, extrait,
// puis lance Vite build sur tous les HTML (réécrit *.ts -> *.js).

import { join, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";
import { ensureDir, emptyDir, walk } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { UntarStream } from "jsr:@std/tar/untar-stream";
import { build as viteBuild } from "npm:vite@5.4.10";

type RegistryMeta = {
  "dist-tags": Record<string, string>;
  versions: Record<string, { dist: { tarball: string } }>;
};

type Config = {
  package: string;
  version?: string;
  outDir?: string;
  externalizeBareImports?: boolean;
};

const CONFIG_FILE = resolve("./npm_vite_build.json");

async function readConfig(): Promise<Config> {
  const raw = await Deno.readTextFile(CONFIG_FILE).catch(() => {
    throw new Error(`Config introuvable: ${CONFIG_FILE}`);
  });
  const cfg = JSON.parse(raw) as Partial<Config>;
  if (!cfg.package || typeof cfg.package !== "string") {
    throw new Error(`Champ "package" manquant ou invalide dans ${CONFIG_FILE}`);
  }
  return {
    package: cfg.package,
    version: cfg.version || "",
    outDir: cfg.outDir || "dist",
    externalizeBareImports: cfg.externalizeBareImports ?? true,
  };
}

async function fetchLatestTarball(p: string, v?: string) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(p)}`);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status} ${res.statusText}`);
  const meta = (await res.json()) as RegistryMeta;
  const ver = (v && v.trim().length) ? v : meta["dist-tags"].latest;
  const tarball = meta.versions[ver]?.dist?.tarball;
  if (!tarball) throw new Error(`Tarball not found for ${p}@${ver}`);
  return { version: ver, tarball };
}

async function extractTgz(tgzBytes: Uint8Array, destDir: string) {
  const stream = new Blob([tgzBytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());
  for await (const entry of stream as any) {
    const out = join(destDir, entry.path);
    if (entry.type === "directory") {
      await ensureDir(out);
    } else if (entry.readable) {
      await ensureDir(out.replace(/[/\\][^/\\]+$/, ""));
      await entry.readable.pipeTo((await Deno.create(out)).writable);
    }
  }
}

function isHtmlPath(p: string) { return /\.html?$/i.test(p); }

async function main() {
  const cfg = await readConfig();
  const OUT_DIR = resolve(cfg.outDir!);

  console.log(`→ Resolving ${cfg.package}@${cfg.version || "latest"}…`);
  const { version, tarball } = await fetchLatestTarball(cfg.package, cfg.version);
  console.log(`  version: ${version}`);
  console.log(`  tarball: ${tarball}`);

  const tmp = await Deno.makeTempDir({ prefix: "npm-tgz-" });
  const tgz = join(tmp, "pkg.tgz");

  console.log("→ Downloading tarball…");
  const resp = await fetch(tarball);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  await Deno.writeFile(tgz, bytes);

  console.log("→ Extracting…");
  const extractDir = join(tmp, "extract");
  await ensureDir(extractDir);
  await extractTgz(bytes, extractDir);

  // La plupart des paquets ont "package/" comme racine
  const pkgRoot = await (async () => {
    try {
      const p = join(extractDir, "package");
      const s = await Deno.stat(p);
      return s.isDirectory ? p : extractDir;
    } catch { return extractDir; }
  })();

  // Entrées HTML pour Vite (multi-page)
  const htmlInputs: string[] = [];
  for await (const e of walk(pkgRoot, { includeDirs: false, followSymlinks: false })) {
    const rel = e.path.slice(pkgRoot.length + 1);
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    if (isHtmlPath(e.path)) htmlInputs.push(e.path);
  }
  if (htmlInputs.length === 0) {
    console.warn("⚠️  Aucun fichier HTML trouvé. Vite n’aura rien à traiter.");
  }

  await emptyDir(OUT_DIR);

  console.log("→ Vite build… (réécriture .ts → .js dans l’HTML)");
  await viteBuild({
    root: pkgRoot,
    logLevel: "info",
    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      rollupOptions: {
        input: htmlInputs.length ? htmlInputs : undefined,
        // Externaliser uniquement les imports "bare" (ex: "react"), pas les chemins relatifs/absolus/URL/HTML/virtuels.
        ...(cfg.externalizeBareImports ? {
          external: (id: string) => {
            // ne jamais externaliser les modules virtuels Rollup ni les HTML
            if (id.startsWith("\0") || /\.html?$/i.test(id)) return false;

            const isRelative = id.startsWith("./") || id.startsWith("../");
            const isAbsPosix = id.startsWith("/");
            const isAbsWin = /^[A-Za-z]:[\\/]/.test(id);
            const isUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(id); // http:, https:, data:, node:, etc.

            // external UNIQUEMENT pour les bare specifiers (ni relatifs, ni absolus, ni URL)
            return !(isRelative || isAbsPosix || isAbsWin || isUrl);
          },
        } : {}),
        output: {
          entryFileNames: (chunk) => {
            const n = chunk.name || "entry";
            return `assets/${n}.js`;
          },
          chunkFileNames: (chunk) => {
            const n = chunk.name || "chunk";
            return `assets/${n}.js`;
          },
          assetFileNames: (asset) => {
            const n = typeof asset.name === "string" ? asset.name.replace(/\.[^./\\]+$/, "") : "asset";
            const ext = (asset.name?.match(/\.[^./\\]+$/)?.[0] ?? ".bin");
            return `assets/${n}${ext}`;
          },
        },
      },
      sourcemap: false,
      cssCodeSplit: true,
      manifest: false,
      modulePreload: false,
    },
  });

  console.log(`✅ Fait. Sortie dans: ${OUT_DIR}`);
  console.log(`   Package traité: ${cfg.package}@${version}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("❌ Error:", err?.stack ?? err?.message ?? err);
    Deno.exit(1);
  });
}
