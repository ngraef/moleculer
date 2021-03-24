"use strict";

const _ = require("lodash");
const H = require("./helpers");
const semver = require("semver");

// Mock agent exporter to avoid failed network requests
jest.mock("dd-trace/packages/dd-trace/src/exporters/agent");

// Build list of supported Scope implementations to test
let supportedScopes = ["async_hooks" /*, "async_resource"*/];
if (semver.satisfies(process.versions.node, ">=14.5 || ^12.19.0")) {
	supportedScopes.push("async_local_storage");
}

supportedScopes.forEach((scope) => {
	describe(`Test Tracing Datadog exporter - ${scope} scope`, () => {
		let STORE = [];

		const COMMON_SETTINGS = {
			logger: false,
			logLevel: "trace",
			namespace: "tracing",
			tracing: {
				enabled: true,
				actions: true,
				events: false,
				sampling: {
					rate: 1,
				},
				exporter: [
					{
						type: "Datadog",
						options: {
							tracerOptions: {
								scope,
							},
						},
					},
					{
						type: "Event",
						options: {
							interval: 0,
						},
					},
				],
			},
		};

		const TestTracingService = {
			name: "tracing-collector",
			events: {
				"$tracing.spans"(ctx) {
					STORE.push(...ctx.params);
				},
				"some.event"() {},
			},
			actions: {
				async echo(ctx) {
					await new Promise((r) => setTimeout(r, 1000));
					return ctx.params;
				},

				async getSpan() {
					const span = this.broker.tracer.exporter[0].ddTracer
						.scope()
						.active();
					const context = span.context();

					return {
						traceId: context._traceId
							.toString(16)
							.padStart(16, "0"),
						spanId: context._spanId.toString(16).padStart(16, "0"),
						parentId: context._parentId
							? context._parentId.toString(16).padStart(16, "0")
							: null,
						tags: context._tags,
					};
				},

				async triggerEvent(ctx) {
					await ctx.emit("some.event", { foo: "bar" });
				},

				async log(ctx) {
					this.logger.info(
						`Called with param value=${ctx.params.value}`
					);
					if (ctx.params.recurse) {
						await ctx.call(ctx.action.name, {
							value: `double ${ctx.params.value}`,
							recurse: false,
						});
					}
				},
			},
		};

		const broker = H.createNode(
			_.defaultsDeep({ nodeID: "broker-0" }, COMMON_SETTINGS),
			[TestTracingService]
		);

		beforeAll(() => broker.start());

		afterAll(() => broker.stop());

		beforeEach(() => {
			jest.resetAllMocks();
			STORE = [];
		});

		it("sets the span as active in dd-trace", async () => {
			const span = await broker.call("tracing-collector.getSpan", {
				foo: "bar",
			});

			expect(STORE).toHaveLength(1);
			expect(span).not.toBeNull();
			expect(span.traceId).toBe(
				STORE[0].traceID.replace(/-/g, "").slice(0, 16)
			);
			expect(span.spanId).toBe(
				STORE[0].id.replace(/-/g, "").slice(0, 16)
			);
			expect(span.parentId).toBeNull();
			expect(span.tags).toEqual(
				expect.objectContaining({
					requestID: STORE[0].tags.requestID,
					"action.name": "tracing-collector.getSpan",
					"params.foo": "bar",
				})
			);
		});

		it("has an isolated async context", async () => {
			const request = broker.call("tracing-collector.echo", {
				phrase: "hello",
			});

			// Check sync context
			const ddTracer = broker.tracer.exporter[0].ddTracer;
			let span = ddTracer.scope().active();
			expect(span).toBeNull();

			await request;

			span = ddTracer.scope().active();
			expect(span).toBeNull();
		});

		it("can be used with log injector", async () => {
			const logSpy = jest.spyOn(console, "log").mockImplementation();
			const logTestBroker = H.createNode(
				_.defaultsDeep(
					{
						nodeID: "broker-1",
						logLevel: "info",
						logger: {
							type: "Console",
							options: {
								colors: false,
								formatter(
									level,
									args,
									bindings,
									{ printArgs }
								) {
									const record = {
										ts: Date.now(),
										level,
										msg: printArgs(args).join(" "),
										dd: {},
										...bindings,
									};

									const traceId =
										this.broker.tracer &&
										this.broker.tracer.getCurrentTraceID();
									if (traceId && record.mod !== "tracer") {
										record.dd.trace_id = traceId;
										record.dd.span_id = this.broker.tracer.getActiveSpanID();
										return [JSON.stringify(record)];
									}

									// For testing purposes, only log messages associated with a trace
									return [];
								},
							},
						},
					},
					COMMON_SETTINGS
				),
				[TestTracingService]
			);

			await logTestBroker.start();
			await logTestBroker.call("tracing-collector.log", {
				value: "test",
				recurse: true,
			});
			await logTestBroker.stop();

			// Filter out empty logs
			const calls = logSpy.mock.calls.filter(
				(call) => call[0] !== undefined
			);

			// Expect only 2 logs. If more, span context is not being properly deactivated
			expect(calls).toHaveLength(2);

			// Expect logger to be called with injected log
			const log1 = JSON.parse(calls[0][0]);
			expect(log1).toEqual({
				ts: expect.any(Number),
				level: "info",
				msg: "Called with param value=test",
				dd: {
					trace_id: expect.any(String),
					span_id: expect.any(String),
				},
				nodeID: "broker-1",
				ns: "tracing",
				mod: "tracing-collector",
				svc: "tracing-collector",
			});

			const log2 = JSON.parse(calls[1][0]);
			expect(log2).toEqual({
				ts: expect.any(Number),
				level: "info",
				msg: "Called with param value=double test",
				dd: {
					trace_id: expect.any(String),
					span_id: expect.any(String),
				},
				nodeID: "broker-1",
				ns: "tracing",
				mod: "tracing-collector",
				svc: "tracing-collector",
			});

			// Expect trace ids to be equal and span ids to be different
			expect(log1.dd.trace_id).toEqual(log1.dd.span_id);
			expect(log1.dd.trace_id).toEqual(log2.dd.trace_id);
			expect(log1.dd.span_id).not.toEqual(log2.dd.span_id);
		});
	});
});
