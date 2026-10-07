import { mkdir } from "node:fs/promises";

const outdir = "dist";
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
    entrypoints: ["src/cli/bin.ts"],
    target: "node",
    outdir,
    naming: "cli.js",
    minify: true,
    define: {
        "import.meta.main": "false",
    },
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

const output = result.outputs[0];
if (output === undefined) throw new Error("build produced no output");
console.log(`${output.path}  ${(output.size / 1024).toFixed(1)} KB`);
