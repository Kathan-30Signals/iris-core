import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const regressionTest = join(dirname(fileURLToPath(import.meta.url)), "first-request-tools.test.mjs");

test("the first-request regression does not contact an inherited secret broker", { timeout: 45_000 }, async (t) => {
	const requests = [];
	const broker = createServer((req, res) => {
		requests.push(req.url);
		res.writeHead(404, { "content-type": "application/json" });
		res.end("{}");
	});
	t.after(() => {
		broker.closeAllConnections();
		broker.close();
	});
	await new Promise((resolve, reject) => {
		broker.once("error", reject);
		broker.listen(0, "127.0.0.1", resolve);
	});

	// Give the test process a configured broker, using only local test settings.
	// Its runtime subprocess must not inherit that configuration.
	const child = spawn(process.execPath, ["--test", regressionTest], {
		env: {
			PATH: process.env.PATH,
			IRIS_SECRET_BROKER_URL: `http://127.0.0.1:${broker.address().port}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill());
	let output = "";
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { output += chunk; });
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	assert.equal(code, 0, output);
	assert.deepEqual(requests, [], "runtime inherited the test process's secret broker");
});
