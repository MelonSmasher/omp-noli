import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

if (process.argv.includes("--seed")) {
	const input = JSON.parse(process.env.NOLI_READ_SEED ?? "null") as {data:string; sdk:string; bridge:string} | null;
	assert(input && [input.data,input.sdk,input.bridge].every(isAbsolute),"Explicit absolute artifact and disposable data paths required");
	const binary = /^(\d+\.\d+\.\d+)-(omp-[a-z]+-[a-z0-9_]+)-([a-f0-9]{64})$/.exec(basename(input.sdk));
	const producer = /^(\d+\.\d+\.\d+)-([a-f0-9]{40})$/.exec(basename(input.bridge));
	assert(binary && producer,"Immutable certified OMP and separately prepared producer artifacts required");
	const manifest = JSON.parse(await readFile(join(input.sdk,"sdk/node_modules/@oh-my-pi/pi-coding-agent/package.json"),"utf8"));
	assert.equal(manifest.name,"@oh-my-pi/pi-coding-agent");
	assert.equal(manifest.version,binary[1]);
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(join(input.sdk,"omp"))) digest.update(chunk);
	assert.equal(digest.digest("hex"),binary[3],"Certified executable digest must match the immutable artifact");
	const managed = join(input.data,"managed-omp");
	const release = join(managed,"releases",basename(input.sdk));
	await mkdir(join(release,"sdk"),{recursive:true,mode:0o700});
	for (const file of ["omp","sdk-ready.json","sdk/package.json","sdk/bun.lock","sdk/official-package.tgz","sdk/node_modules"]) {
		await cp(join(input.sdk,file),join(release,file),{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
	}
	const installed = join(input.data,"bridge-releases",basename(input.bridge));
	await mkdir(join(input.data,"bridge-releases"),{recursive:true,mode:0o700});
	await cp(input.bridge,installed,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
	const id = crypto.randomUUID();
	await mkdir(join(managed,"generations",id,"root"),{recursive:true,mode:0o700});
	await writeFile(join(managed,"active.json"),JSON.stringify({format:1,id,
		binary:{version:binary[1],asset:binary[2],sha256:binary[3]},bridge_version:producer[1],bridge_commit:producer[2],state_generation:id,previous:null}),{mode:0o600});
	await writeFile(join(managed,"activation.json"),"null",{mode:0o600});
	process.stdout.write(JSON.stringify({sdk_version:binary[1],sdk_sha256:binary[3],bridge_version:producer[1],bridge_commit:producer[2],
		sdk_path:join(release,"sdk/node_modules/@oh-my-pi/pi-coding-agent"),producer_path:join(installed,"src/index.ts"),
		driver_path:join(installed,"scripts/fixtures/forge-read-runtime.ts")}));
} else {
	const args = process.argv.slice(2);
	assert(args.length===4 && args[0]==="--runtime" && args[2]==="--config","Usage: bun scripts/smoke-forge-read.ts --runtime /absolute/forge_read_tools_smoke --config /private/real-forge.json");
	assert(isAbsolute(args[1]!) && isAbsolute(args[3]!),"Explicit built Runtime smoke and private configuration paths required");
	// No fixture server, SDK clone, gh/glab identity or model endpoint is substituted.
	const child = Bun.spawn([args[1]!,args[3]!],{stdin:"ignore",stdout:"inherit",stderr:"inherit",
		env:{PATH:"/usr/bin:/bin:/usr/sbin:/sbin",HOME:process.env.HOME ?? "/nonexistent"}});
	process.exit(await child.exited);
}
