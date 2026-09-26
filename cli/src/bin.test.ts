import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the npm executable prints help when invoked through a symlink", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    bin: { veto: string };
  };
  const source = pkg.bin.veto.replace("./dist/", "./src/").replace(/\.js$/, ".ts");
  const target = fileURLToPath(new URL(`../${source}`, import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "veto-bin-test-"));
  try {
    const executable = join(directory, "veto");
    symlinkSync(target, executable);
    const result = spawnSync(process.execPath, ["--import", "tsx", executable, "--help"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /veto connect/);
    assert.match(result.stdout, /veto pay/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
