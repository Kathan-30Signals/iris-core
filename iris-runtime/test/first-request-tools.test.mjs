// Regression for #281: after the pi 1.0 upgrade the first model request of a
// brand-new session went out with no `tools`, because run() kept AgentSession's
// unpersisted in-memory tool declaration when the session file was empty.
// Drives a real runtime through the bridge against a fake OpenAI Responses
// server and asserts the first request carries the built-in tools.
//
// Requires `npm run build` first (spawns ../dist/main.js).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const mainJs = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");

function sse(events) {
	return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function responseEvents() {
	const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
	const base = { id: "resp_1", object: "response", model: "fake-model", status: "in_progress", output: [] };
	return [
		{ type: "response.created", response: base },
		{ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "ok" },
		{ type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: message.content[0] },
		{ type: "response.output_item.done", output_index: 0, item: message },
		{ type: "response.completed", response: { ...base, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	];
}

function listen(server) {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("the first request of a new session is sent with the built-in tools", async () => {
	const seenTools = [];
	const fake = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => {
			if (req.url?.endsWith("/responses")) seenTools.push(JSON.parse(body).tools ?? []);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sse(responseEvents()));
		});
	});
	const fakePort = await listen(fake);

	const workingDir = mkdtempSync(join(tmpdir(), "iris-first-request-tools-"));
	writeFileSync(join(workingDir, "models.json"), JSON.stringify({
		providers: {
			fake: {
				baseUrl: `http://127.0.0.1:${fakePort}/v1`,
				api: "openai-responses",
				apiKey: "fake-key",
				models: [{ id: "fake-model", name: "Fake", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		},
	}));

	const probe = createServer();
	const bridgePort = await listen(probe);
	await new Promise((resolve) => probe.close(resolve));

	const child = spawn(process.execPath, [mainJs, "--sandbox=host", workingDir], {
		// Keep real transport credentials, secret providers, and telemetry out of
		// this runtime: it must only use the temporary workspace and fake model.
		env: {
			PATH: process.env.PATH,
			HOME: workingDir,
			IRIS_BRIDGE_PORT: String(bridgePort),
			IRIS_PROVIDER: "fake",
			IRIS_MODEL: "fake-model",
		},
		stdio: "ignore",
	});

	try {
		let response;
		for (let i = 0; i < 100 && !response; i++) {
			try {
				response = await fetch(`http://127.0.0.1:${bridgePort}/bridge`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "first-request-tools", text: "hi" }),
					signal: AbortSignal.timeout(30_000),
				});
			} catch (err) {
				if (err?.name === "TimeoutError") throw err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		assert.ok(response, "bridge never came up");
		assert.ok(seenTools.length > 0, "the fake provider received no request");
		assert.ok(seenTools[0].length > 0, "first request was sent with no tools");
		assert.ok(seenTools[0].some((t) => t.name === "bash"));
	} finally {
		child.kill();
		fake.close();
	}
});
